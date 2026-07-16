import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  SafeAreaView,
  ScrollView,
  Alert,
  Switch,
  ActivityIndicator,
  Modal,
  Share,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAudioPlayer, AudioModule } from 'expo-audio';
import { useAppAudioRecorder, useAppAudioRecorderState } from '../../utils/audioRecorder';

import { colors } from '../../constants/colors';
import { spacing, layout, shadows } from '../../constants/spacing';
import { typography } from '../../constants/typography';
import { languages, getLanguageName } from '../../constants/languages';
import { supabase, callEdgeFunction } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { elevenLabsService } from '../../services/elevenLabs';
import { resolveConversationDirection, ConversationTurn } from '../../utils/conversationDirection';

type ConversationProcessingState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'stopping'
  | 'uploading'
  | 'transcribing'
  | 'detecting-language'
  | 'language-mismatch'
  | 'translating'
  | 'generating-speech'
  | 'ready'
  | 'error';

export default function ConverseTab() {
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Language Setup
  const [topLanguage, setTopLanguage] = useState('ta'); // Tamil
  const [bottomLanguage, setBottomLanguage] = useState('en'); // English
  const [activeLangModal, setActiveLangModal] = useState<'top' | 'bottom' | null>(null);

  // Settings
  const [isFaceToFace, setIsFaceToFace] = useState(false);
  const [vadEnabled, setVadEnabled] = useState(true);
  const [autoPlay, setAutoPlay] = useState(true);

  // Conversation States
  const [isRecording, setIsRecording] = useState(false);
  const [processingState, setProcessingState] = useState<ConversationProcessingState>('idle');
  const [statusText, setStatusText] = useState('');
  
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const [lastDetectedLanguage, setLastDetectedLanguage] = useState<string | null>(null);
  
  // Modals / Overlays
  const [showHistory, setShowHistory] = useState(false);
  const [mismatchTurn, setMismatchTurn] = useState<ConversationTurn | null>(null);
  const [tempAudioUri, setTempAudioUri] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);

  // Audio Recorder & Player setup
  const recorder = useAppAudioRecorder({
    isMeteringEnabled: true,
  });
  const recorderState = useAppAudioRecorderState(recorder, 100);
  const player = useAudioPlayer('');

  // VAD state & elapsed timer
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [hasSpoken, setHasSpoken] = useState(false);
  const silenceFramesRef = useRef(0);

  // Fetch profile to get native language
  const { data: profile } = useQuery<any>({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      return data;
    },
    enabled: !!user?.id,
  });

  const nativeCode = profile?.native_language || 'en';

  // Stopwatch effect
  useEffect(() => {
    let interval: any;
    if (isRecording) {
      setElapsedSeconds(0);
      interval = setInterval(() => {
        setElapsedSeconds(prev => prev + 1);
      }, 1000);
    } else {
      setElapsedSeconds(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  // VAD automatic stop detection
  useEffect(() => {
    if (!isRecording || !vadEnabled) {
      setHasSpoken(false);
      silenceFramesRef.current = 0;
      return;
    }

    const db = recorderState?.metering ?? -60;
    
    if (!hasSpoken) {
      if (db > -35) {
        setHasSpoken(true);
      }
    } else {
      if (db < -42) {
        silenceFramesRef.current += 1;
        // 20 frames of 100ms = 2.0s silence to stop automatically
        if (silenceFramesRef.current >= 20) {
          console.log("VAD silence detected, automatically stopping recording.");
          handleStopRecording();
        }
      } else {
        silenceFramesRef.current = 0;
      }
    }
  }, [recorderState?.metering, isRecording, hasSpoken, vadEnabled]);

  // Fetch bookmarks maps
  const [bookmarkedIds, setBookmarkedIds] = useState<Record<string, boolean>>({});

  const { data: conversationBookmarks = [] } = useQuery<any[]>({
    queryKey: ['conversationBookmarks', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('bookmarks')
        .select('translation_item_id')
        .eq('user_id', user.id);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });

  useEffect(() => {
    const bookmarkedMap: Record<string, boolean> = {};
    conversationBookmarks.forEach(b => {
      if (b.translation_item_id) {
        bookmarkedMap[b.translation_item_id] = true;
      }
    });
    setBookmarkedIds(bookmarkedMap);
  }, [conversationBookmarks]);

  // Sync session turns from DB on mount or when session ID is set
  const { data: dbTurns = [], refetch: refetchHistory } = useQuery<any[]>({
    queryKey: ['conversationTurns', sessionIdRef.current],
    queryFn: async () => {
      if (!sessionIdRef.current) return [];
      const { data, error } = await supabase
        .from('translation_items')
        .select('*')
        .eq('session_id', sessionIdRef.current)
        .order('sequence_number', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!sessionIdRef.current,
  });

  useEffect(() => {
    if (dbTurns && dbTurns.length > 0) {
      setTurns(dbTurns.map(mapDbRowToTurn));
    }
  }, [dbTurns]);

  function mapDbRowToTurn(row: any): ConversationTurn {
    return {
      id: row.id,
      sessionId: row.session_id,
      detectedLanguage: row.detected_language || '',
      detectedLanguageName: row.detected_language_name || '',
      sourceLanguage: row.source_language || '',
      targetLanguage: row.target_language || '',
      sourcePanel: (row.source_panel as 'first' | 'second' | 'unknown') || 'unknown',
      originalText: row.source_text || '',
      translatedText: row.translated_text || '',
      detectionMode: (row.detection_mode as 'provider' | 'previous-turn-fallback' | 'manual') || 'provider',
      originalAudioUrl: row.source_audio_path || undefined,
      translatedAudioUrl: row.generated_audio_path || undefined,
      createdAt: row.created_at,
      status: (row.status as 'processing' | 'complete' | 'failed') || 'complete',
      transcriptionError: row.transcription_error || undefined,
      translationError: row.translation_error || undefined,
      speechError: row.speech_error || undefined,
    };
  }

  const getOrCreateSession = async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!user) return null;
    
    const { data: session, error } = await supabase
      .from('translation_sessions')
      .insert({
        user_id: user.id,
        status: 'active',
        metadata: {
          isFaceToFace,
          firstLanguage: topLanguage,
          secondLanguage: bottomLanguage,
        }
      } as any)
      .select()
      .single();

    if (error) {
      console.error("Error creating session:", error);
      throw error;
    }
    sessionIdRef.current = session.id;
    return session.id;
  };

  const saveTurnToDb = async (turn: ConversationTurn) => {
    if (!user) return;
    try {
      const sessionId = await getOrCreateSession();
      const { error } = await supabase
        .from('translation_items')
        .upsert({
          id: turn.id,
          session_id: sessionId,
          user_id: user.id,
          speaker_id: turn.sourcePanel === 'first' ? 'A' : 'B',
          sequence_number: turns.length + 1,
          source_text: turn.originalText,
          translated_text: turn.translatedText || null,
          detected_language: turn.detectedLanguage || null,
          detected_language_name: turn.detectedLanguageName || null,
          source_language: turn.sourceLanguage,
          target_language: turn.targetLanguage,
          source_panel: turn.sourcePanel,
          detection_mode: turn.detectionMode,
          status: turn.status,
          transcription_error: turn.transcription_error || null,
          translation_error: turn.translation_error || null,
          speech_error: turn.speechError || null,
          generated_audio_path: turn.translatedAudioUrl || null,
          created_at: turn.createdAt,
        } as any);

      if (error) {
        console.error("Error saving turn to db:", error);
      }
      refetchHistory();
    } catch (e) {
      console.error("Error saving turn:", e);
    }
  };

  const handleToggleRecording = async () => {
    if (processingState !== 'idle' && processingState !== 'ready' && processingState !== 'error') {
      return;
    }

    if (isRecording) {
      await handleStopRecording();
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Stop playback
    try {
      player.pause();
    } catch (e) {
      console.log("Error pausing player:", e);
    }

    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission Denied', 'Microphone recording permission is required.');
      return;
    }

    try {
      setIsRecording(true);
      setProcessingState('recording');
      setStatusText('Listening...');
      await recorder.record();
    } catch (e: any) {
      console.error(e);
      setIsRecording(false);
      setProcessingState('idle');
    }
  };

  const handleStopRecording = async () => {
    if (!isRecording) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    setIsRecording(false);
    setProcessingState('stopping');
    setStatusText('Processing audio...');

    try {
      const completedUri = await recorder.stop();
      const audioUri = completedUri || recorder.uri;
      if (!audioUri) {
        throw new Error('No recorded audio file found.');
      }
      setTempAudioUri(audioUri);
      await processAudio(audioUri);
    } catch (err: any) {
      console.error(err);
      setProcessingState('error');
      setStatusText('Failed to record');
      Alert.alert('Recording Failed', err.message || 'Error occurred while saving audio.');
    }
  };

  const processAudio = async (audioUri: string, languageHint?: string) => {
    const turnId = Math.random().toString(36).substring(7);
    setCurrentTurnId(turnId);

    setProcessingState('transcribing');
    setStatusText('Processing audio...');

    const newTurn: ConversationTurn = {
      id: turnId,
      detectedLanguage: '',
      detectedLanguageName: '',
      sourceLanguage: '',
      targetLanguage: '',
      sourcePanel: 'unknown',
      originalText: '',
      translatedText: '',
      detectionMode: 'provider',
      createdAt: new Date().toISOString(),
      status: 'processing',
    };

    setTurns(prev => [...prev, newTurn]);

    try {
      // 1. Transcribe
      const result = await elevenLabsService.transcribeAudio(audioUri, languageHint);
      if (!result.text || !result.text.trim()) {
        throw new Error('Empty transcription. Please speak clearly.');
      }

      setTurns(prev => prev.map(t => t.id === turnId ? {
        ...t,
        originalText: result.text,
        detectedLanguage: result.detectedLanguage || '',
        detectedLanguageName: result.detectedLanguageName || '',
      } : t));

      // 2. Resolve Direction
      const resolution = resolveConversationDirection({
        detectedLanguage: result.detectedLanguage,
        firstLanguage: topLanguage,
        secondLanguage: bottomLanguage,
        previousDetectedLanguage: lastDetectedLanguage,
        transcript: result.text
      });

      const updatedTurn: ConversationTurn = {
        ...newTurn,
        originalText: result.text,
        detectedLanguage: result.detectedLanguage || '',
        detectedLanguageName: result.detectedLanguageName || '',
        sourceLanguage: resolution.sourceLanguage,
        targetLanguage: resolution.targetLanguage,
        sourcePanel: resolution.sourcePanel,
        detectionMode: resolution.inferredFromPrevious ? 'previous-turn-fallback' : 'provider',
      };

      setTurns(prev => prev.map(t => t.id === turnId ? updatedTurn : t));

      if (resolution.status === 'language-mismatch' || resolution.status === 'manual-required') {
        setMismatchTurn(updatedTurn);
        setProcessingState('language-mismatch');
        setStatusText('Language mismatch');
        return;
      }

      // Resolved! Translate
      setProcessingState('translating');
      setStatusText(`Translating to ${getLanguageName(resolution.targetLanguage)}...`);

      const { data: translationResult, error: transError } = await callEdgeFunction<{
        translated_text: string;
      }>('translate-text', {
        source: resolution.sourceLanguage,
        target: resolution.targetLanguage,
        text: result.text,
      });

      if (transError || !translationResult) {
        throw transError || new Error('Failed to translate text.');
      }

      const translatedText = translationResult.translated_text;

      // Update in state
      setTurns(prev => prev.map(t => t.id === turnId ? {
        ...t,
        translatedText,
        status: 'complete'
      } : t));

      // Generate Speech
      await handleRetrySpeech(turnId, translatedText);

      setLastDetectedLanguage(result.detectedLanguage);
    } catch (e: any) {
      console.error(e);
      setProcessingState('error');
      setStatusText('Processing failed');
      setTurns(prev => prev.map(t => t.id === turnId ? {
        ...t,
        transcriptionError: e.message || 'Processing failed',
        status: 'failed'
      } : t));
    }
  };

  const handleRetryTranslation = async (turnId: string) => {
    const turn = turns.find(t => t.id === turnId);
    if (!turn) return;
    
    setProcessingState('translating');
    setStatusText(`Translating to ${getLanguageName(turn.targetLanguage)}...`);

    try {
      const { data: translationResult, error: transError } = await callEdgeFunction<{
        translated_text: string;
      }>('translate-text', {
        source: turn.sourceLanguage,
        target: turn.targetLanguage,
        text: turn.originalText,
      });

      if (transError || !translationResult) {
        throw transError || new Error('Failed to translate text.');
      }

      const translatedText = translationResult.translated_text;

      setTurns(prev => prev.map(t => t.id === turnId ? {
        ...t,
        translatedText,
        translationError: undefined,
        status: 'complete'
      } : t));

      await handleRetrySpeech(turnId, translatedText);
    } catch (e: any) {
      console.error(e);
      setProcessingState('error');
      setStatusText('Translation failed');
      setTurns(prev => prev.map(t => t.id === turnId ? {
        ...t,
        translationError: e.message || 'Translation failed'
      } : t));
    }
  };

  const handleRetrySpeech = async (turnId: string, customText?: string) => {
    const turn = turns.find(t => t.id === turnId);
    if (!turn) return;

    const textToUse = customText || turn.translatedText;
    if (!textToUse) return;

    setProcessingState('generating-speech');
    setStatusText(`Preparing ${getLanguageName(turn.targetLanguage)} voice...`);

    try {
      const sessionId = await getOrCreateSession();
      const ttsResult = await elevenLabsService.generateSpeech(
        textToUse,
        profile?.selected_voice_id || '21m00Tcm4TlvDq8ikWAM',
        true,
        sessionId || undefined
      );

      if (!ttsResult || !ttsResult.url) {
        throw new Error('TTS returned empty audio URL');
      }

      const finalTurn = {
        ...turn,
        translatedText: textToUse,
        translatedAudioUrl: ttsResult.url,
        speechError: undefined,
        status: 'complete' as const
      };

      setTurns(prev => prev.map(t => t.id === turnId ? finalTurn : t));
      await saveTurnToDb(finalTurn);

      setProcessingState('ready');
      setStatusText('Ready');

      if (autoPlay && ttsResult.url) {
        player.replace({ uri: ttsResult.url });
        player.play();
      }
    } catch (e: any) {
      console.error(e);
      setProcessingState('error');
      setStatusText('Voice generation failed');
      
      const failedTurn = {
        ...turn,
        translatedText: textToUse,
        speechError: e.message || 'TTS generation failed',
        status: 'failed' as const
      };

      setTurns(prev => prev.map(t => t.id === turnId ? failedTurn : t));
      await saveTurnToDb(failedTurn);
    }
  };

  const handleManualDirectionResolve = async (
    turnId: string,
    sourceLanguage: string,
    targetLanguage: string,
    sourcePanel: 'first' | 'second'
  ) => {
    const turn = turns.find(t => t.id === turnId);
    if (!turn) return;

    const updatedTurn: ConversationTurn = {
      ...turn,
      sourceLanguage,
      targetLanguage,
      sourcePanel,
      detectionMode: 'manual',
    };

    setTurns(prev => prev.map(t => t.id === turnId ? updatedTurn : t));
    setMismatchTurn(null);

    setProcessingState('translating');
    setStatusText(`Translating to ${getLanguageName(targetLanguage)}...`);
    try {
      const { data: translationResult, error: transError } = await callEdgeFunction<{
        translated_text: string;
      }>('translate-text', {
        source: sourceLanguage,
        target: targetLanguage,
        text: turn.originalText,
      });

      if (transError || !translationResult) {
        throw transError || new Error('Failed to translate text.');
      }

      const translatedText = translationResult.translated_text;

      const nextTurnState = {
        ...updatedTurn,
        translatedText,
        status: 'complete' as const,
      };

      setTurns(prev => prev.map(t => t.id === turnId ? nextTurnState : t));
      await handleRetrySpeech(turnId, translatedText);
      setLastDetectedLanguage(sourceLanguage);
    } catch (e: any) {
      console.error(e);
      setProcessingState('error');
      setStatusText('Translation failed');
      setTurns(prev => prev.map(t => t.id === turnId ? {
        ...t,
        translationError: e.message || 'Translation failed',
        status: 'failed'
      } : t));
    }
  };

  const handleRetranscribeWithHint = async (turnId: string, languageHint: string) => {
    const turn = turns.find(t => t.id === turnId);
    if (!turn || !tempAudioUri) return;

    setMismatchTurn(null);
    setProcessingState('transcribing');
    setStatusText(`Retranscribing using ${getLanguageName(languageHint)} hint...`);

    try {
      const result = await elevenLabsService.transcribeAudio(tempAudioUri, languageHint);
      if (!result.text || !result.text.trim()) {
        throw new Error('Retranscription returned empty text');
      }

      const resolution = resolveConversationDirection({
        detectedLanguage: result.detectedLanguage || languageHint,
        firstLanguage: topLanguage,
        secondLanguage: bottomLanguage,
        previousDetectedLanguage: lastDetectedLanguage,
        transcript: result.text
      });

      const updatedTurn: ConversationTurn = {
        ...turn,
        originalText: result.text,
        detectedLanguage: result.detectedLanguage || languageHint,
        detectedLanguageName: result.detectedLanguageName || getLanguageName(result.detectedLanguage || languageHint),
        status: 'processing',
      };

      setTurns(prev => prev.map(t => t.id === turnId ? updatedTurn : t));

      if (resolution.status === 'language-mismatch' || resolution.status === 'manual-required') {
        setMismatchTurn(updatedTurn);
        setProcessingState('language-mismatch');
      } else {
        await handleManualDirectionResolve(
          turnId, 
          resolution.sourceLanguage, 
          resolution.targetLanguage, 
          resolution.sourcePanel as 'first' | 'second'
        );
      }
    } catch (e: any) {
      console.error(e);
      setProcessingState('error');
      setStatusText('Retranscription failed');
      Alert.alert('Retranscription Error', e.message || 'Could not retranscribe audio.');
    }
  };

  const handleSwapLanguages = () => {
    Haptics.selectionAsync();
    const temp = topLanguage;
    setTopLanguage(bottomLanguage);
    setBottomLanguage(temp);
  };

  const selectLanguage = (code: string) => {
    Haptics.selectionAsync();
    if (activeLangModal === 'top') {
      setTopLanguage(code);
    } else if (activeLangModal === 'bottom') {
      setBottomLanguage(code);
    }
    setActiveLangModal(null);
  };

  const handleToggleBookmark = async (turn: ConversationTurn) => {
    if (!user) {
      Alert.alert('Sign in Required', 'Bookmarking translations is only available for registered users.');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    const isAlreadyBookmarked = bookmarkedIds[turn.id];
    try {
      if (isAlreadyBookmarked) {
        const { error } = await supabase
          .from('bookmarks')
          .delete()
          .eq('user_id', user.id)
          .eq('translation_item_id', turn.id);
        if (error) throw error;
        setBookmarkedIds(prev => ({ ...prev, [turn.id]: false }));
      } else {
        const { error } = await supabase
          .from('bookmarks')
          .insert({
            user_id: user.id,
            translation_item_id: turn.id,
            source_text: turn.originalText,
            translated_text: turn.translatedText,
            source_language: turn.sourceLanguage,
            target_language: turn.targetLanguage,
            tags: ['conversation'],
            note: turn.detectedLanguageName ? `Detected: ${turn.detectedLanguageName}` : '',
          } as any);
        if (error) throw error;
        setBookmarkedIds(prev => ({ ...prev, [turn.id]: true }));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (e) {
      console.error("Error toggling bookmark:", e);
    }
  };

  const handleShareTurn = async (turn: ConversationTurn) => {
    try {
      await Share.share({
        message: `Original (${getLanguageName(turn.sourceLanguage)}): ${turn.originalText}\nTranslation (${getLanguageName(turn.targetLanguage)}): ${turn.translatedText}`,
      });
    } catch (e) {
      console.error("Error sharing turn:", e);
    }
  };

  const handleCopyTurn = async (turn: ConversationTurn) => {
    await Share.share({
      message: turn.translatedText
    });
  };

  const handleResetSession = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Alert.alert(
      'Clear Conversation',
      'Are you sure you want to clear current logs and start fresh?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            setTurns([]);
            setLastDetectedLanguage(null);
            sessionIdRef.current = null;
            setProcessingState('idle');
            setStatusText('');
          }
        }
      ]
    );
  };

  const handleFinishSession = async () => {
    if (turns.length === 0) {
      Alert.alert('Empty Session', 'Record some conversation before finishing.');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Finish Conversation',
      'Would you like to complete this session and view summary analysis?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Finish & View Summary',
          onPress: async () => {
            if (sessionIdRef.current) {
              await supabase
                .from('translation_sessions')
                .update({ status: 'completed' } as any)
                .eq('id', sessionIdRef.current);
              
              router.push(`/conversation-summary?sessionId=${sessionIdRef.current}`);
            } else {
              router.back();
            }
          }
        }
      ]
    );
  };

  const lastCompletedTurn = [...turns].reverse().find(t => t.status === 'complete' || t.status === 'failed');

  const renderFirstPanel = () => {
    if (processingState === 'transcribing' || processingState === 'detecting-language') {
      return (
        <View style={styles.emptyPanelContent}>
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={[styles.emptyPanelTextDark, { marginTop: 12 }]}>{statusText}</Text>
        </View>
      );
    }

    if (!lastCompletedTurn) {
      return (
        <View style={styles.emptyPanelContent}>
          <Ionicons name="mic-outline" size={36} color="rgba(255, 255, 255, 0.3)" />
          <Text style={styles.emptyPanelTextDark}>Speak {getLanguageName(topLanguage)} or {getLanguageName(bottomLanguage)}</Text>
        </View>
      );
    }

    const isSource = lastCompletedTurn.sourcePanel === 'first';
    
    if (isSource) {
      return (
        <View style={styles.panelCard}>
          <View style={styles.panelCardHeader}>
            <Text style={styles.panelCardLangDark}>{getLanguageName(topLanguage).toUpperCase()}</Text>
            {lastCompletedTurn.detectedLanguageName && (
              <Text style={styles.panelCardDetectedDark}>({lastCompletedTurn.detectedLanguageName})</Text>
            )}
          </View>
          <Text style={styles.panelCardTextDark}>{lastCompletedTurn.originalText}</Text>
        </View>
      );
    } else {
      if (lastCompletedTurn.translationError) {
        return (
          <View style={styles.errorCard}>
            <Ionicons name="warning" size={24} color={colors.error} style={{ marginBottom: 8 }} />
            <Text style={styles.errorCardTextDark}>Translation failed</Text>
            <Pressable style={styles.retryBtnDark} onPress={() => handleRetryTranslation(lastCompletedTurn.id)}>
              <Ionicons name="refresh" size={14} color="#FFFFFF" style={{ marginRight: 4 }} />
              <Text style={styles.retryBtnTextDark}>Retry translation</Text>
            </Pressable>
          </View>
        );
      }

      return (
        <View style={styles.panelCard}>
          <View style={styles.panelCardHeader}>
            <Text style={styles.panelCardLangDark}>{getLanguageName(topLanguage).toUpperCase()}</Text>
            {lastCompletedTurn.translatedAudioUrl && (
              <Pressable 
                style={styles.speakerIconDark} 
                onPress={() => {
                  player.replace({ uri: lastCompletedTurn.translatedAudioUrl });
                  player.play();
                }}
              >
                <Ionicons name="volume-medium" size={22} color="#FFFFFF" />
              </Pressable>
            )}
          </View>
          <Text style={styles.panelCardTextDarkTranslated}>{lastCompletedTurn.translatedText}</Text>
          {lastCompletedTurn.speechError && (
            <View style={styles.errorRow}>
              <Text style={styles.errorSubTextDark}>Voice generation failed</Text>
              <Pressable style={styles.retryTextBtn} onPress={() => handleRetrySpeech(lastCompletedTurn.id)}>
                <Text style={styles.retryTextBtnTxt}>Retry voice</Text>
              </Pressable>
            </View>
          )}
        </View>
      );
    }
  };

  const renderSecondPanel = () => {
    if (processingState === 'translating' || processingState === 'generating-speech') {
      return (
        <View style={styles.emptyPanelContent}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.emptyPanelTextLight, { marginTop: 12 }]}>{statusText}</Text>
        </View>
      );
    }

    if (!lastCompletedTurn) {
      return (
        <View style={styles.emptyPanelContent}>
          <Ionicons name="sparkles-outline" size={36} color="rgba(0, 0, 0, 0.25)" />
          <Text style={styles.emptyPanelTextLight}>Language is detected automatically</Text>
        </View>
      );
    }

    const isSource = lastCompletedTurn.sourcePanel === 'second';

    if (isSource) {
      return (
        <View style={styles.panelCard}>
          <View style={styles.panelCardHeader}>
            <Text style={styles.panelCardLangLight}>{getLanguageName(bottomLanguage).toUpperCase()}</Text>
            {lastCompletedTurn.detectedLanguageName && (
              <Text style={styles.panelCardDetectedLight}>({lastCompletedTurn.detectedLanguageName})</Text>
            )}
          </View>
          <Text style={styles.panelCardTextLight}>{lastCompletedTurn.originalText}</Text>
        </View>
      );
    } else {
      if (lastCompletedTurn.translationError) {
        return (
          <View style={styles.errorCard}>
            <Ionicons name="warning" size={24} color={colors.error} style={{ marginBottom: 8 }} />
            <Text style={styles.errorCardTextLight}>Translation failed</Text>
            <Pressable style={styles.retryBtnLight} onPress={() => handleRetryTranslation(lastCompletedTurn.id)}>
              <Ionicons name="refresh" size={14} color={colors.textPrimary} style={{ marginRight: 4 }} />
              <Text style={styles.retryBtnTextLight}>Retry translation</Text>
            </Pressable>
          </View>
        );
      }

      return (
        <View style={styles.panelCard}>
          <View style={styles.panelCardHeader}>
            <Text style={styles.panelCardLangLight}>{getLanguageName(bottomLanguage).toUpperCase()}</Text>
            {lastCompletedTurn.translatedAudioUrl && (
              <Pressable 
                style={styles.speakerIconLight} 
                onPress={() => {
                  player.replace({ uri: lastCompletedTurn.translatedAudioUrl });
                  player.play();
                }}
              >
                <Ionicons name="volume-medium" size={22} color={colors.textPrimary} />
              </Pressable>
            )}
          </View>
          <Text style={styles.panelCardTextLightTranslated}>{lastCompletedTurn.translatedText}</Text>
          {lastCompletedTurn.speechError && (
            <View style={styles.errorRow}>
              <Text style={styles.errorSubTextLight}>Voice generation failed</Text>
              <Pressable style={styles.retryTextBtn} onPress={() => handleRetrySpeech(lastCompletedTurn.id)}>
                <Text style={styles.retryTextBtnTxt}>Retry voice</Text>
              </Pressable>
            </View>
          )}
        </View>
      );
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />

      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.headerBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </Pressable>

        <View style={styles.headerLangContainer}>
          <Pressable 
            style={[styles.headerLangSelector, topLanguage === nativeCode && styles.meSelector]} 
            onPress={() => setActiveLangModal('top')}
          >
            <Text style={styles.headerLangText}>{getLanguageName(topLanguage)}</Text>
            {topLanguage === nativeCode && (
              <View style={styles.meBadge}>
                <Text style={styles.meBadgeText}>Me</Text>
              </View>
            )}
          </Pressable>

          <Pressable style={styles.headerSwapBtn} onPress={handleSwapLanguages}>
            <Ionicons name="swap-horizontal" size={16} color={colors.primary} />
          </Pressable>

          <Pressable 
            style={[styles.headerLangSelector, bottomLanguage === nativeCode && styles.meSelector]} 
            onPress={() => setActiveLangModal('bottom')}
          >
            <Text style={styles.headerLangText}>{getLanguageName(bottomLanguage)}</Text>
            {bottomLanguage === nativeCode && (
              <View style={styles.meBadge}>
                <Text style={styles.meBadgeText}>Me</Text>
              </View>
            )}
          </Pressable>
        </View>

        <Pressable style={styles.headerBtn} onPress={() => setShowHistory(true)}>
          <Ionicons name="time" size={24} color={colors.textPrimary} />
        </Pressable>
      </View>

      {/* Main content panels */}
      <View style={styles.mainContent}>
        {/* Top Dark Panel */}
        <View style={[
          styles.topPanel,
          lastCompletedTurn && lastCompletedTurn.sourcePanel === 'first' && styles.activePanelGlowDark
        ]}>
          {renderFirstPanel()}
        </View>

        {/* Bottom Light Panel */}
        <View style={[
          styles.bottomPanel,
          lastCompletedTurn && lastCompletedTurn.sourcePanel === 'second' && styles.activePanelGlowLight
        ]}>
          {renderSecondPanel()}

          {/* Badges/Settings Row at the bottom */}
          <View style={styles.bottomSettingsRow}>
            <View style={styles.settingToggle}>
              <Text style={styles.settingText}>Auto-VAD</Text>
              <Switch
                value={vadEnabled}
                onValueChange={setVadEnabled}
                thumbColor={colors.primary}
                trackColor={{ true: colors.primary, false: colors.borderStrong }}
              />
            </View>

            <View style={styles.settingToggle}>
              <Text style={styles.settingText}>Auto-Play</Text>
              <Switch
                value={autoPlay}
                onValueChange={setAutoPlay}
                thumbColor={colors.primary}
                trackColor={{ true: colors.primary, false: colors.borderStrong }}
              />
            </View>

            <Pressable style={styles.actionBtnIcon} onPress={handleResetSession}>
              <Ionicons name="trash" size={18} color={colors.error} />
            </Pressable>

            <Pressable style={styles.actionBtnText} onPress={handleFinishSession}>
              <Text style={styles.actionBtnTextTxt}>Finish</Text>
            </Pressable>
          </View>
        </View>

        {/* Central Overlay Mic Button */}
        <View style={styles.centerMicContainer}>
          {isRecording ? (
            <View style={styles.waveRow}>
              {recorderState?.metering !== undefined && [1, 2, 3, 4, 5].map((_, i) => {
                const db = recorderState.metering;
                const norm = Math.max(10, Math.min(60, (db + 60) * 1.2));
                return (
                  <View 
                    key={i} 
                    style={[
                      styles.waveBar, 
                      { height: norm + Math.random() * 8, backgroundColor: colors.error }
                    ]} 
                  />
                );
              })}
            </View>
          ) : null}

          <Pressable
            style={[
              styles.centerMicButton,
              isRecording && styles.centerMicButtonRecording
            ]}
            onPress={handleToggleRecording}
            disabled={processingState !== 'idle' && processingState !== 'ready' && processingState !== 'error'}
          >
            {processingState === 'transcribing' || processingState === 'translating' || processingState === 'generating-speech' ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Ionicons 
                name={isRecording ? "stop" : "mic"} 
                size={32} 
                color="#FFFFFF" 
              />
            )}
          </Pressable>

          {isRecording && (
            <Text style={styles.timerText}>
              00:{elapsedSeconds < 10 ? `0${elapsedSeconds}` : elapsedSeconds}
            </Text>
          )}
        </View>
      </View>

      {/* Language Picker Modal */}
      <Modal
        visible={activeLangModal !== null}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setActiveLangModal(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Choose Language</Text>
              <Pressable onPress={() => setActiveLangModal(null)} style={styles.modalCloseBtn}>
                <Ionicons name="close" size={24} color={colors.textPrimary} />
              </Pressable>
            </View>
            <ScrollView style={styles.languagesList} showsVerticalScrollIndicator={false}>
              {languages.map((lang) => (
                <Pressable
                  key={lang.code}
                  style={styles.languageItem}
                  onPress={() => selectLanguage(lang.code)}
                >
                  <Text style={styles.languageItemText}>{lang.name}</Text>
                  <Text style={styles.languageItemNative}>{lang.nativeName}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Language Mismatch Modal */}
      {mismatchTurn && (
        <Modal
          visible={mismatchTurn !== null}
          transparent={true}
          animationType="fade"
        >
          <View style={styles.mismatchOverlay}>
            <View style={styles.mismatchCard}>
              <Ionicons name="alert-circle" size={40} color={colors.warning} style={{ marginBottom: 12 }} />
              <Text style={styles.mismatchTitle}>{mismatchTurn.detectedLanguageName || 'Unknown Language'} Detected</Text>
              <Text style={styles.mismatchSubtitle}>
                Whisper detected "{mismatchTurn.detectedLanguageName}" which does not match your active pair ({getLanguageName(topLanguage)} ↔ {getLanguageName(bottomLanguage)}).
              </Text>

              <ScrollView contentContainerStyle={styles.mismatchActions} style={{ maxHeight: 280 }}>
                <Pressable 
                  style={styles.mismatchBtnPrimary}
                  onPress={() => {
                    const detectedCode = mismatchTurn.detectedLanguage;
                    if (detectedCode) {
                      setBottomLanguage(detectedCode);
                      handleManualDirectionResolve(mismatchTurn.id, detectedCode, topLanguage, 'second');
                    }
                  }}
                >
                  <Text style={styles.mismatchBtnPrimaryText}>Replace {getLanguageName(bottomLanguage)} with {mismatchTurn.detectedLanguageName}</Text>
                </Pressable>

                <Pressable 
                  style={styles.mismatchBtnSecondary}
                  onPress={() => handleManualDirectionResolve(mismatchTurn.id, topLanguage, bottomLanguage, 'first')}
                >
                  <Text style={styles.mismatchBtnSecondaryText}>Treat as {getLanguageName(topLanguage)}</Text>
                </Pressable>

                <Pressable 
                  style={styles.mismatchBtnSecondary}
                  onPress={() => handleManualDirectionResolve(mismatchTurn.id, bottomLanguage, topLanguage, 'second')}
                >
                  <Text style={styles.mismatchBtnSecondaryText}>Treat as {getLanguageName(bottomLanguage)}</Text>
                </Pressable>

                <Pressable 
                  style={styles.mismatchBtnSecondary}
                  onPress={() => handleRetranscribeWithHint(mismatchTurn.id, topLanguage)}
                >
                  <Text style={styles.mismatchBtnSecondaryText}>Retranscribe using {getLanguageName(topLanguage)} hint</Text>
                </Pressable>

                <Pressable 
                  style={styles.mismatchBtnSecondary}
                  onPress={() => handleRetranscribeWithHint(mismatchTurn.id, bottomLanguage)}
                >
                  <Text style={styles.mismatchBtnSecondaryText}>Retranscribe using {getLanguageName(bottomLanguage)} hint</Text>
                </Pressable>

                <Pressable 
                  style={[styles.mismatchBtnSecondary, { borderColor: colors.error }]}
                  onPress={() => {
                    setTurns(prev => prev.filter(t => t.id !== mismatchTurn.id));
                    setMismatchTurn(null);
                    setProcessingState('idle');
                  }}
                >
                  <Text style={[styles.mismatchBtnSecondaryText, { color: colors.error }]}>Record again</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      {/* History Modal */}
      <Modal
        visible={showHistory}
        animationType="slide"
        onRequestClose={() => setShowHistory(false)}
      >
        <SafeAreaView style={styles.historyContainer}>
          <View style={styles.historyHeader}>
            <Text style={styles.historyTitle}>Session History</Text>
            <Pressable onPress={() => setShowHistory(false)} style={styles.closeBtn}>
              <Ionicons name="close" size={24} color={colors.textPrimary} />
            </Pressable>
          </View>

          {turns.length === 0 ? (
            <View style={styles.emptyHistory}>
              <Ionicons name="time-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyHistoryTxt}>No speech logs in this session yet.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.historyList} showsVerticalScrollIndicator={false}>
              {turns.map((turn, index) => {
                const isBookmarked = bookmarkedIds[turn.id];
                return (
                  <View key={turn.id} style={styles.historyItemCard}>
                    <View style={styles.historyItemMeta}>
                      <Text style={styles.historyItemIndex}>#{index + 1}</Text>
                      <Text style={styles.historyItemLang}>
                        {getLanguageName(turn.sourceLanguage)} → {getLanguageName(turn.targetLanguage)}
                      </Text>
                      <Text style={styles.historyItemMode}>({turn.detectionMode})</Text>
                    </View>

                    <Text style={styles.historyItemOriginal}>{turn.originalText}</Text>
                    <Text style={styles.historyItemTranslated}>{turn.translatedText}</Text>

                    {/* Quick audio play */}
                    {turn.translatedAudioUrl && (
                      <Pressable 
                        style={styles.replayRow}
                        onPress={() => {
                          player.replace({ uri: turn.translatedAudioUrl });
                          player.play();
                        }}
                      >
                        <Ionicons name="play" size={12} color={colors.primary} />
                        <Text style={styles.replayTxt}>Play translated audio</Text>
                      </Pressable>
                    )}

                    <View style={styles.historyActionsRow}>
                      {/* Manual correction triggers */}
                      <Pressable 
                        style={styles.actionPill}
                        onPress={() => handleManualDirectionResolve(turn.id, topLanguage, bottomLanguage, 'first')}
                      >
                        <Text style={styles.actionPillText}>Force {getLanguageName(topLanguage)}</Text>
                      </Pressable>

                      <Pressable 
                        style={styles.actionPill}
                        onPress={() => handleManualDirectionResolve(turn.id, bottomLanguage, topLanguage, 'second')}
                      >
                        <Text style={styles.actionPillText}>Force {getLanguageName(bottomLanguage)}</Text>
                      </Pressable>

                      <View style={{ flex: 1 }} />

                      <Pressable style={styles.actionCircle} onPress={() => handleToggleBookmark(turn)}>
                        <Ionicons 
                          name={isBookmarked ? "bookmark" : "bookmark-outline"} 
                          size={16} 
                          color={isBookmarked ? colors.accentOrange : colors.textSecondary} 
                        />
                      </Pressable>

                      <Pressable style={styles.actionCircle} onPress={() => handleShareTurn(turn)}>
                        <Ionicons name="share-outline" size={16} color={colors.textSecondary} />
                      </Pressable>

                      <Pressable style={styles.actionCircle} onPress={() => handleCopyTurn(turn)}>
                        <Ionicons name="copy-outline" size={16} color={colors.textSecondary} />
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </SafeAreaView>
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
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  headerBtn: {
    padding: 6,
  },
  headerLangContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceSoft,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerLangSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  meSelector: {
    backgroundColor: 'rgba(92, 107, 192, 0.1)',
  },
  headerLangText: {
    ...typography.captionMedium,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  meBadge: {
    backgroundColor: colors.primary,
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 4,
  },
  meBadgeText: {
    fontSize: 8,
    color: '#FFFFFF',
    fontWeight: '700',
  },
  headerSwapBtn: {
    padding: 4,
    marginHorizontal: 4,
  },
  mainContent: {
    flex: 1,
    position: 'relative',
  },
  topPanel: {
    flex: 1,
    backgroundColor: '#1C1C1E',
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#2C2C2E',
  },
  bottomPanel: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activePanelGlowDark: {
    backgroundColor: '#1E1E24',
  },
  activePanelGlowLight: {
    backgroundColor: '#FAF9FB',
  },
  emptyPanelContent: {
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.8,
  },
  emptyPanelTextDark: {
    ...typography.bodyMedium,
    color: 'rgba(255, 255, 255, 0.45)',
    textAlign: 'center',
    marginTop: 8,
  },
  emptyPanelTextLight: {
    ...typography.bodyMedium,
    color: 'rgba(0, 0, 0, 0.4)',
    textAlign: 'center',
    marginTop: 8,
  },
  panelCard: {
    width: '100%',
    padding: 8,
  },
  panelCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  panelCardLangDark: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.accentBlue,
    letterSpacing: 1,
  },
  panelCardLangLight: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.primary,
    letterSpacing: 1,
  },
  panelCardDetectedDark: {
    fontSize: 9,
    color: 'rgba(255, 255, 255, 0.4)',
  },
  panelCardDetectedLight: {
    fontSize: 9,
    color: 'rgba(0, 0, 0, 0.4)',
  },
  panelCardTextDark: {
    fontSize: 22,
    fontWeight: '500',
    color: '#FFFFFF',
    lineHeight: 28,
  },
  panelCardTextDarkTranslated: {
    fontSize: 24,
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: 30,
  },
  panelCardTextLight: {
    fontSize: 22,
    fontWeight: '500',
    color: '#1C1C1E',
    lineHeight: 28,
  },
  panelCardTextLightTranslated: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.primary,
    lineHeight: 30,
  },
  speakerIconDark: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 16,
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  speakerIconLight: {
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderRadius: 16,
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorCard: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  errorCardTextDark: {
    color: 'rgba(255, 255, 255, 0.7)',
    marginBottom: 8,
  },
  errorCardTextLight: {
    color: '#1C1C1E',
    marginBottom: 8,
  },
  retryBtnDark: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  retryBtnTextDark: {
    fontSize: 12,
    color: '#FFFFFF',
    fontWeight: '700',
  },
  retryBtnLight: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceSoft,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  retryBtnTextLight: {
    fontSize: 12,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  errorSubTextDark: {
    fontSize: 10,
    color: colors.error,
    marginRight: 6,
  },
  errorSubTextLight: {
    fontSize: 10,
    color: colors.error,
    marginRight: 6,
  },
  retryTextBtn: {
    padding: 2,
  },
  retryTextBtnTxt: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.primary,
    textDecorationLine: 'underline',
  },
  bottomSettingsRow: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 16,
    padding: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  settingToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  settingText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  actionBtnIcon: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#FBE9E7',
  },
  actionBtnText: {
    backgroundColor: colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionBtnTextTxt: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  centerMicContainer: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: [{ translateX: -70 }, { translateY: -78 }],
    width: 140,
    height: 140,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  centerMicButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 8,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  centerMicButtonRecording: {
    backgroundColor: colors.error,
  },
  waveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 36,
    marginBottom: 8,
  },
  waveBar: {
    width: 3,
    borderRadius: 1.5,
  },
  timerText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: colors.background,
    borderTopLeftRadius: layout.cardRadius,
    borderTopRightRadius: layout.cardRadius,
    height: '60%',
    padding: spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: colors.border,
    paddingBottom: spacing.sm,
    marginBottom: spacing.sm,
  },
  modalTitle: {
    ...typography.heading3,
    color: colors.textPrimary,
  },
  modalCloseBtn: {
    padding: 4,
  },
  languagesList: {
    flex: 1,
  },
  languageItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 0.5,
    borderColor: colors.border,
  },
  languageItemText: {
    ...typography.bodyMedium,
    color: colors.textPrimary,
  },
  languageItemNative: {
    ...typography.caption,
    color: colors.textMuted,
  },
  mismatchOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
  },
  mismatchCard: {
    width: '85%',
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 15,
    elevation: 10,
  },
  mismatchTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  mismatchSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
  },
  mismatchActions: {
    gap: 8,
    width: '100%',
  },
  mismatchBtnPrimary: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
    marginBottom: 6,
  },
  mismatchBtnPrimaryText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  mismatchBtnSecondary: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
  },
  mismatchBtnSecondaryText: {
    color: colors.textPrimary,
    fontWeight: '600',
    fontSize: 13,
  },
  historyContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  historyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  closeBtn: {
    padding: 4,
  },
  emptyHistory: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.6,
  },
  emptyHistoryTxt: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 10,
  },
  historyList: {
    padding: 20,
    gap: 16,
  },
  historyItemCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  historyItemMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 6,
  },
  historyItemIndex: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textMuted,
    backgroundColor: colors.surfaceSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  historyItemLang: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.primary,
  },
  historyItemMode: {
    fontSize: 9,
    color: colors.textMuted,
  },
  historyItemOriginal: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  historyItemTranslated: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.primary,
    marginBottom: 10,
  },
  replayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 12,
  },
  replayTxt: {
    fontSize: 11,
    color: colors.primary,
    fontWeight: '700',
  },
  historyActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 0.5,
    borderColor: colors.border,
    paddingTop: 10,
  },
  actionPill: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 0.5,
    borderColor: colors.borderStrong,
  },
  actionPillText: {
    fontSize: 9,
    color: colors.textSecondary,
    fontWeight: '700',
  },
  actionCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
