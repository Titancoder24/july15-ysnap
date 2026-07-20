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
  Share,
  Platform,
  Dimensions,
  Modal,
  Clipboard,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { colors, spacing, typography } from '../../constants';
import { supabase, callEdgeFunction } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useAppAudioRecorder } from '../../utils/audioRecorder';
import { AudioModule, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { elevenLabsService } from '../../services/elevenLabs';
import { getLanguageName, languages } from '../../constants/languages';

const { width } = Dimensions.get('window');

interface DictationTurn {
  id: string;
  text: string;
  translatedText?: string;
  detectedLanguage: string;
  detectedLanguageName: string;
  targetLanguage: string;
  targetLanguageName: string;
  originalAudioUrl?: string;
  translatedAudioUrl?: string; // TTS playback url of translated text
  createdAt: string;
}

export default function ConverseTab() {
  const router = useRouter();
  const { user } = useAuth();

  // Media players & recorders
  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);
  const recorder = useAppAudioRecorder();

  // App State
  const [text, setText] = useState<string>('');
  const [translatedText, setTranslatedText] = useState<string>('');
  const [detectedLangCode, setDetectedLangCode] = useState<string>('');
  const [detectedLangName, setDetectedLangName] = useState<string>('');
  const [targetLangCode, setTargetLangCode] = useState<string>('en'); // Default target: English

  const [isRecording, setIsRecording] = useState(false);
  const [processingState, setProcessingState] = useState<'idle' | 'recording' | 'transcribing' | 'speaking' | 'error'>('idle');
  const [statusText, setStatusText] = useState('');
  
  // Toggles
  const [vadEnabled, setVadEnabled] = useState(true);
  const [autoPlay, setAutoPlay] = useState(true);

  // History logs
  const [turns, setTurns] = useState<DictationTurn[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);

  // VAD Stopwatch / silence detection emulator for client
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Sync preferences voice
  const [preferences, setPreferences] = useState<any>(null);

  useEffect(() => {
    if (user) {
      supabase
        .from('user_preferences')
        .select('*')
        .eq('user_id', user.id)
        .single()
        .then(({ data }) => {
          if (data) setPreferences(data);
        });
      
      // Load history
      loadHistory();
    }
  }, [user]);

  // Handle playback completion to release recording buttons
  useEffect(() => {
    const isFinished = status.duration > 0 
      ? status.currentTime >= status.duration - 0.2 
      : false;
    
    if (processingState === 'speaking' && !status.playing && (isFinished || isNaN(status.duration) || status.duration === 0)) {
      setProcessingState('idle');
      setStatusText('');
    }
  }, [status.playing, status.currentTime, status.duration, processingState]);

  // Recording timer
  useEffect(() => {
    if (isRecording) {
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => {
        setElapsedSeconds(prev => {
          // Stop recording automatically if it reaches 45 seconds (prevent long runaway audio)
          if (prev >= 45) {
            handleToggleRecording();
            return 45;
          }
          return prev + 1;
        });
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  const loadHistory = async () => {
    if (!user) return;
    try {
      const { data, error } = await supabase
        .from('translation_items')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;

      if (data) {
        const loaded: DictationTurn[] = data.map((row: any) => ({
          id: row.id,
          text: row.source_text || '',
          translatedText: row.translated_text || '',
          detectedLanguage: row.detected_language || '',
          detectedLanguageName: row.detected_language_name || 'English',
          targetLanguage: row.target_language || '',
          targetLanguageName: row.target_language ? getLanguageName(row.target_language) : '',
          originalAudioUrl: row.source_audio_path || undefined,
          translatedAudioUrl: row.generated_audio_path || undefined,
          createdAt: row.created_at,
        }));
        setTurns(loaded);
      }
    } catch (e) {
      console.error("Error loading history:", e);
    }
  };

  const uploadAudioToStorage = async (localUri: string): Promise<string | null> => {
    if (!user) return null;
    try {
      const fileExt = localUri.split('.').pop() || 'wav';
      const fileName = `${Date.now()}.${fileExt}`;
      const path = `${user.id}/${fileName}`;
      
      const response = await fetch(localUri);
      const blob = await response.blob();

      const { data, error } = await supabase.storage
        .from('media')
        .upload(path, blob, {
          contentType: `audio/${fileExt}`,
          cacheControl: '3600',
          upsert: false
        });

      if (error) {
        console.error("Storage upload error:", error);
        return null;
      }

      const { data: urlData } = supabase.storage
        .from('media')
        .getPublicUrl(path);

      return urlData?.publicUrl || null;
    } catch (e) {
      console.error("Error uploading audio to storage:", e);
      return null;
    }
  };

  const saveDictationToDb = async (turn: DictationTurn) => {
    if (!user) return;
    try {
      const { error } = await supabase
        .from('translation_items')
        .insert({
          id: turn.id,
          user_id: user.id,
          speaker_id: 'A',
          sequence_number: turns.length + 1,
          source_text: turn.text,
          translated_text: turn.translatedText || null,
          detected_language: turn.detectedLanguage || null,
          detected_language_name: turn.detectedLanguageName || null,
          source_language: turn.detectedLanguage,
          target_language: turn.targetLanguage || turn.detectedLanguage,
          source_panel: 'first',
          detection_mode: 'provider',
          status: 'complete',
          source_audio_path: turn.originalAudioUrl || null,
          generated_audio_path: turn.translatedAudioUrl || null,
          created_at: turn.createdAt,
        } as any);

      if (error) {
        console.error("Error saving dictation turn:", error);
      }
      loadHistory();
    } catch (e) {
      console.error("Error saving dictation:", e);
    }
  };

  const handleToggleRecording = async () => {
    if (isRecording) {
      await handleStopRecording();
      return;
    }

    if (processingState !== 'idle' && processingState !== 'error') {
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Stop current playback
    try {
      player.pause();
    } catch (e) {
      console.log("Error pausing player:", e);
    }

    if (Platform.OS !== 'web') {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Denied', 'Microphone recording permission is required.');
        return;
      }
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
    setProcessingState('transcribing');
    setStatusText('Transcribing speech...');

    try {
      const completedUri = await recorder.stop();
      const audioUri = completedUri || recorder.uri;
      if (!audioUri) {
        throw new Error('No recorded audio file found.');
      }
      await processAudio(audioUri);
    } catch (err: any) {
      console.error(err);
      setProcessingState('error');
      setStatusText('Failed to record');
      Alert.alert('Recording Failed', err.message || 'Error occurred while saving audio.');
    }
  };

  const processAudio = async (audioUri: string) => {
    setProcessingState('transcribing');
    setStatusText('Transcribing speech...');

    try {
      // 1. Upload raw audio file
      let originalAudioUrl: string | null = null;
      try {
        originalAudioUrl = await uploadAudioToStorage(audioUri);
      } catch (uploadErr) {
        console.error("Failed to upload audio file:", uploadErr);
      }

      // 2. Call Speech-to-Text Edge Function
      const result = await elevenLabsService.transcribeAudio(audioUri);
      if (!result.text || !result.text.trim()) {
        throw new Error('Could not capture speech. Please speak clearly and try again.');
      }

      const langCode = result.detectedLanguage || 'en';
      const langName = result.detectedLanguageName || getLanguageName(langCode);

      setText(result.text);
      setDetectedLangCode(langCode);
      setDetectedLangName(langName);

      // 3. Translate from Spoken Language to Target Language
      let translated = '';
      if (langCode.toLowerCase().trim() !== targetLangCode.toLowerCase().trim()) {
        setProcessingState('transcribing');
        setStatusText(`Translating to ${getLanguageName(targetLangCode)}...`);
        try {
          const { data: translationResult, error: transError } = await callEdgeFunction<{
            translated_text: string;
          }>('translate-text', {
            source: langCode,
            target: targetLangCode,
            text: result.text,
          });

          if (transError || !translationResult) {
            throw transError || new Error('Translation failed');
          }
          translated = translationResult.translated_text;
        } catch (transErr) {
          console.error("Translation failed:", transErr);
          translated = '[Translation Failed]';
        }
      } else {
        translated = result.text; // Same language
      }
      setTranslatedText(translated);

      // Create new turn object
      const newTurn: DictationTurn = {
        id: Math.random().toString(36).substring(7),
        text: result.text,
        translatedText: translated,
        detectedLanguage: langCode,
        detectedLanguageName: langName,
        targetLanguage: targetLangCode,
        targetLanguageName: getLanguageName(targetLangCode),
        originalAudioUrl: originalAudioUrl || undefined,
        createdAt: new Date().toISOString(),
      };

      setTurns(prev => [newTurn, ...prev]);

      // 4. Generate voice playback in target language if autoPlay is enabled
      let translatedAudioUrl = '';
      if (autoPlay && translated && translated !== '[Translation Failed]') {
        setProcessingState('speaking');
        setStatusText(`Playing playback voice...`);
        try {
          const ttsResult = await elevenLabsService.generateSpeech(
            translated,
            preferences?.selected_voice_id || '21m00Tcm4TlvDq8ikWAM',
            true
          );
          if (ttsResult && ttsResult.url) {
            translatedAudioUrl = ttsResult.url;
            newTurn.translatedAudioUrl = ttsResult.url;
            
            player.replace({ uri: ttsResult.url });
            player.play();
          }
        } catch (ttsErr) {
          console.error("TTS playback failed:", ttsErr);
        }
      }

      // 5. Save turn to database
      await saveDictationToDb(newTurn);

      setProcessingState('idle');
      setStatusText('');
    } catch (e: any) {
      console.error(e);
      setProcessingState('error');
      setStatusText('Transcription failed');
      Alert.alert('Transcription Failed', e.message || 'Speech could not be transcribed.');
    }
  };

  const handleCopyText = async (targetText: string) => {
    if (!targetText) return;
    Clipboard.setString(targetText);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('Copied', 'Text copied to clipboard.');
  };

  const handleShareText = async () => {
    if (!text) return;
    const shareMessage = translatedText && translatedText !== text 
      ? `Spoken (${detectedLangName}): ${text}\n\nTranslation (${getLanguageName(targetLangCode)}): ${translatedText}`
      : text;
    try {
      await Share.share({
        message: shareMessage,
      });
    } catch (e) {
      console.error("Error sharing text:", e);
    }
  };

  const handlePlayTTS = async (audioText: string, playTarget: boolean) => {
    if (!audioText) return;
    setProcessingState('speaking');
    setStatusText('Generating audio speech...');
    try {
      const ttsResult = await elevenLabsService.generateSpeech(
        audioText,
        preferences?.selected_voice_id || '21m00Tcm4TlvDq8ikWAM',
        true
      );
      if (ttsResult && ttsResult.url) {
        player.replace({ uri: ttsResult.url });
        player.play();
      }
    } catch (e) {
      console.error("TTS generation error:", e);
      Alert.alert('Playback Failed', 'Could not synthesize voice playback.');
    } finally {
      setProcessingState('idle');
    }
  };

  const handleClearText = () => {
    Haptics.selectionAsync();
    setText('');
    setTranslatedText('');
    setDetectedLangCode('');
    setDetectedLangName('');
    setProcessingState('idle');
    setStatusText('');
  };

  const selectTargetLanguage = (code: string) => {
    Haptics.selectionAsync();
    setTargetLangCode(code);
    setShowLangPicker(false);
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />

      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.headerBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#1A1A1C" />
        </Pressable>
        <Text style={styles.headerTitle}>YSnap Dictate</Text>
        <Pressable style={styles.headerBtn} onPress={() => setShowHistory(true)}>
          <Ionicons name="time-outline" size={24} color="#1A1A1C" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContainer} keyboardShouldPersistTaps="handled">
        {/* Editor Board Card */}
        <View style={styles.dictationBoard}>
          
          {/* Header config: Language status + Target selector */}
          <View style={styles.boardConfigRow}>
            {detectedLangName ? (
              <View style={styles.detectedBadge}>
                <Ionicons name="earth" size={13} color={colors.accentBlue} style={{ marginRight: 4 }} />
                <Text style={styles.detectedLabelTxt}>From: <Text style={{ color: colors.accentBlue, fontWeight: '700' }}>{detectedLangName}</Text></Text>
              </View>
            ) : (
              <View style={styles.detectedBadge}>
                <Ionicons name="sparkles" size={13} color="rgba(0, 0, 0, 0.4)" style={{ marginRight: 4 }} />
                <Text style={styles.detectedPlaceholderTxt}>Auto-Detecting Input</Text>
              </View>
            )}

            <View style={styles.targetLangSelector}>
              <Text style={styles.toLabel}>To:</Text>
              <Pressable style={styles.langSelectorBtn} onPress={() => setShowLangPicker(true)}>
                <Text style={styles.langSelectorBtnTxt}>{getLanguageName(targetLangCode)}</Text>
                <Ionicons name="chevron-down" size={12} color="#1A1A1C" style={{ marginLeft: 3 }} />
              </Pressable>
            </View>
          </View>

          {/* Text Area containing spoken (and optional translated) text */}
          <ScrollView 
            style={styles.textContainer}
            contentContainerStyle={styles.textScrollContent}
            showsVerticalScrollIndicator={true}
          >
            {processingState === 'transcribing' ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={colors.accentBlue} />
                <Text style={styles.loadingText}>{statusText}</Text>
              </View>
            ) : text ? (
              <View style={styles.dualTextContainer}>
                
                {/* Spoken Text Block */}
                <View style={styles.textBlock}>
                  <View style={styles.textBlockHeader}>
                    <Text style={styles.textBlockTitle}>SPOKEN TEXT ({detectedLangName.toUpperCase()})</Text>
                    <View style={styles.textBlockActions}>
                      <Pressable style={styles.blockActionCircle} onPress={() => handleCopyText(text)}>
                        <Ionicons name="copy-outline" size={14} color="rgba(0, 0, 0, 0.5)" />
                      </Pressable>
                      <Pressable style={styles.blockActionCircle} onPress={() => handlePlayTTS(text, false)}>
                        <Ionicons name="volume-medium-outline" size={15} color="rgba(0, 0, 0, 0.5)" />
                      </Pressable>
                    </View>
                  </View>
                  <Text style={styles.dictatedText}>{text}</Text>
                </View>

                {/* Translation Divider */}
                {translatedText && translatedText !== text ? (
                  <>
                    <View style={styles.divider} />

                    {/* Translated Text Block */}
                    <View style={styles.textBlock}>
                      <View style={styles.textBlockHeader}>
                        <Text style={[styles.textBlockTitle, { color: colors.accentBlue }]}>
                          TRANSLATION ({getLanguageName(targetLangCode).toUpperCase()})
                        </Text>
                        <View style={styles.textBlockActions}>
                          <Pressable style={styles.blockActionCircle} onPress={() => handleCopyText(translatedText)}>
                            <Ionicons name="copy-outline" size={14} color={colors.accentBlue} />
                          </Pressable>
                          <Pressable style={styles.blockActionCircle} onPress={() => handlePlayTTS(translatedText, true)}>
                            <Ionicons name="volume-medium-outline" size={15} color={colors.accentBlue} />
                          </Pressable>
                        </View>
                      </View>
                      <Text style={[styles.dictatedText, { color: '#2D3748' }]}>{translatedText}</Text>
                    </View>
                  </>
                ) : null}

              </View>
            ) : (
              <Text style={styles.placeholderText}>
                Speak in Tamil, Hindi, Spanish, French, Chinese, Arabic, Portuguese, English, or any other majority language.
                {"\n\n"}YSnap will auto-verify the voice, transcribe the text, and instantly translate it to your selected target language ({getLanguageName(targetLangCode)}).
              </Text>
            )}
          </ScrollView>

          {/* Editor Action Buttons (Universal Share / Clear) */}
          {text ? (
            <View style={styles.boardActionsRow}>
              <Pressable style={styles.boardActionBtn} onPress={handleShareText}>
                <Ionicons name="share-outline" size={18} color="#1A1A1C" />
                <Text style={styles.boardActionTxt}>Share Turn</Text>
              </Pressable>

              <Pressable style={[styles.boardActionBtn, { backgroundColor: 'rgba(239, 83, 80, 0.12)' }]} onPress={handleClearText}>
                <Ionicons name="trash-outline" size={18} color={colors.error} />
                <Text style={[styles.boardActionTxt, { color: colors.error }]}>Clear Board</Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        {/* Live Orb & Voice Controller Strip */}
        <View style={styles.micControlCard}>
          {/* Left Settings switches */}
          <View style={styles.micSettings}>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>VAD Auto-stop</Text>
              <Switch
                value={vadEnabled}
                onValueChange={setVadEnabled}
                thumbColor={colors.accentBlue}
                trackColor={{ true: colors.accentBlue, false: 'rgba(0, 0, 0, 0.1)' }}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
            </View>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Auto Playback</Text>
              <Switch
                value={autoPlay}
                onValueChange={setAutoPlay}
                thumbColor={colors.accentBlue}
                trackColor={{ true: colors.accentBlue, false: 'rgba(0, 0, 0, 0.1)' }}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
            </View>
          </View>

          {/* Central Pulsing Microphone Button */}
          <View style={styles.micOrbContainer}>
            {isRecording && (
              <View style={styles.timerWrapper}>
                <Text style={styles.timerText}>
                  00:{elapsedSeconds < 10 ? `0${elapsedSeconds}` : elapsedSeconds}
                </Text>
              </View>
            )}

            <Pressable
              style={[
                styles.micOrb,
                isRecording && styles.micOrbRecording,
                processingState === 'transcribing' && styles.micOrbProcessing
              ]}
              onPress={handleToggleRecording}
            >
              {processingState === 'transcribing' || processingState === 'speaking' ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons 
                  name={isRecording ? "square" : "mic"} 
                  size={32} 
                  color="#FFFFFF" 
                />
              )}
            </Pressable>
            
            <Text style={styles.micStatusLabel}>
              {isRecording ? 'TAP TO COMPLETE' : 'TAP TO RECORD'}
            </Text>
          </View>

          {/* Right helper info */}
          <View style={styles.infoCol}>
            <Ionicons name="mic-circle" size={32} color={isRecording ? colors.accentBlue : 'rgba(0, 0, 0, 0.2)'} />
          </View>
        </View>
      </ScrollView>

      {/* Target Language Picker Modal */}
      <Modal
        visible={showLangPicker}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowLangPicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Choose Target Language</Text>
              <Pressable onPress={() => setShowLangPicker(false)} style={styles.modalCloseBtn}>
                <Ionicons name="close" size={24} color="#1A1A1C" />
              </Pressable>
            </View>
            <ScrollView style={styles.languagesList} showsVerticalScrollIndicator={false}>
              {languages.map((lang) => (
                <Pressable
                  key={lang.code}
                  style={styles.languageItem}
                  onPress={() => selectTargetLanguage(lang.code)}
                >
                  <Text style={styles.languageItemText}>{lang.name}</Text>
                  <Text style={styles.languageItemNative}>{lang.nativeName}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* History Log Sheet Modal */}
      <Modal
        visible={showHistory}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowHistory(false)}
      >
        <SafeAreaView style={styles.historyContainer}>
          <View style={styles.historyHeader}>
            <Text style={styles.historyTitle}>Translation History</Text>
            <Pressable onPress={() => setShowHistory(false)} style={styles.closeBtn}>
              <Ionicons name="close" size={24} color="#1A1A1C" />
            </Pressable>
          </View>

          {turns.length === 0 ? (
            <View style={styles.emptyHistory}>
              <Ionicons name="document-text-outline" size={64} color="rgba(0, 0, 0, 0.2)" />
              <Text style={styles.emptyHistoryTxt}>No translations logged yet.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.historyList} showsVerticalScrollIndicator={false}>
              {turns.map((turn, index) => (
                <View key={turn.id || index} style={styles.historyCard}>
                  <View style={styles.historyCardHeader}>
                    <View style={styles.langPill}>
                      <Text style={styles.langPillTxt}>
                        {turn.detectedLanguageName} → {turn.targetLanguageName || getLanguageName(turn.targetLanguage)}
                      </Text>
                    </View>
                    <Text style={styles.historyTime}>
                      {new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>

                  <View style={styles.historyTextContainer}>
                    <Text style={styles.historyTextOriginal}>{turn.text}</Text>
                    
                    {turn.translatedText && turn.translatedText !== turn.text ? (
                      <>
                        <View style={styles.historyDivider} />
                        <Text style={styles.historyTextTranslated}>{turn.translatedText}</Text>
                      </>
                    ) : null}
                  </View>

                  <View style={styles.historyActions}>
                    {turn.originalAudioUrl && (
                      <Pressable 
                        style={styles.actionBtn}
                        onPress={() => {
                          player.replace({ uri: turn.originalAudioUrl });
                          player.play();
                        }}
                      >
                        <Ionicons name="play-outline" size={14} color="#1A1A1C" style={{ marginRight: 4 }} />
                        <Text style={styles.actionTxt}>Voice</Text>
                      </Pressable>
                    )}

                    {turn.translatedAudioUrl && (
                      <Pressable 
                        style={styles.actionBtn}
                        onPress={() => {
                          player.replace({ uri: turn.translatedAudioUrl });
                          player.play();
                        }}
                      >
                        <Ionicons name="volume-medium-outline" size={14} color={colors.accentBlue} style={{ marginRight: 4 }} />
                        <Text style={[styles.actionTxt, { color: colors.accentBlue }]}>Synthesis</Text>
                      </Pressable>
                    )}

                    <View style={{ flex: 1 }} />

                    <Pressable 
                      style={styles.actionCircle}
                      onPress={async () => {
                        Clipboard.setString(turn.translatedText || turn.text);
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        Alert.alert('Copied', 'Text copied to clipboard.');
                      }}
                    >
                      <Ionicons name="copy-outline" size={16} color="rgba(0, 0, 0, 0.5)" />
                    </Pressable>

                    <Pressable 
                      style={styles.actionCircle}
                      onPress={async () => {
                        try {
                          await Share.share({ 
                            message: turn.translatedText && turn.translatedText !== turn.text
                              ? `${turn.text} => ${turn.translatedText}`
                              : turn.text
                          });
                        } catch (e) {
                          console.error(e);
                        }
                      }}
                    >
                      <Ionicons name="share-social-outline" size={16} color="rgba(0, 0, 0, 0.5)" />
                    </Pressable>
                  </View>
                </View>
              ))}
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
    backgroundColor: '#F8F9FA',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: '#ECEEF1',
    backgroundColor: '#FFFFFF',
  },
  headerBtn: {
    padding: 8,
  },
  headerTitle: {
    ...typography.bodyMedium,
    color: '#1A1A1C',
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  scrollContainer: {
    flexGrow: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: 110,
  },
  dictationBoard: {
    flex: 1,
    minHeight: 380,
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    padding: spacing.md,
    marginBottom: spacing.md,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  boardConfigRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#E4E7EC',
    paddingBottom: spacing.sm,
    marginBottom: spacing.sm,
  },
  detectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detectedLabelTxt: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(0, 0, 0, 0.6)',
  },
  detectedPlaceholderTxt: {
    fontSize: 11,
    fontWeight: '500',
    color: 'rgba(0, 0, 0, 0.4)',
  },
  targetLangSelector: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  toLabel: {
    fontSize: 11,
    color: 'rgba(0, 0, 0, 0.4)',
    marginRight: 4,
    fontWeight: '600',
  },
  langSelectorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.08)',
  },
  langSelectorBtnTxt: {
    fontSize: 11,
    fontWeight: '700',
    color: '#1A1A1C',
  },
  textContainer: {
    flex: 1,
    marginVertical: spacing.xs,
  },
  textScrollContent: {
    flexGrow: 1,
  },
  dualTextContainer: {
    flex: 1,
    gap: 16,
  },
  textBlock: {
    flex: 1,
  },
  textBlockHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  textBlockTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: 'rgba(0, 0, 0, 0.4)',
    letterSpacing: 1,
  },
  textBlockActions: {
    flexDirection: 'row',
    gap: 8,
  },
  blockActionCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.08)',
  },
  dictatedText: {
    fontSize: 18,
    lineHeight: 26,
    color: '#1A1A1C',
    fontWeight: '500',
  },
  divider: {
    height: 1,
    backgroundColor: '#E4E7EC',
    marginVertical: 4,
  },
  placeholderText: {
    fontSize: 15,
    lineHeight: 22,
    color: 'rgba(0, 0, 0, 0.4)',
    fontStyle: 'italic',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
  },
  loadingText: {
    fontSize: 13,
    color: 'rgba(0, 0, 0, 0.6)',
    marginTop: spacing.md,
  },
  boardActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#E4E7EC',
    paddingTop: spacing.md,
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  boardActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
    borderRadius: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.08)',
  },
  boardActionTxt: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1A1A1C',
    marginLeft: 6,
  },
  micControlCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    padding: spacing.md,
    paddingVertical: 18,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  micSettings: {
    flex: 1.2,
    justifyContent: 'center',
    gap: 12,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(0, 0, 0, 0.7)',
  },
  micOrbContainer: {
    flex: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timerWrapper: {
    position: 'absolute',
    top: -24,
    backgroundColor: 'rgba(239, 83, 80, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  timerText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#EF5350',
    letterSpacing: 0.5,
  },
  micOrb: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#EF5350',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#EF5350',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 6,
    marginBottom: spacing.xs,
  },
  micOrbRecording: {
    backgroundColor: '#E53935',
    transform: [{ scale: 1.1 }],
    shadowRadius: 16,
  },
  micOrbProcessing: {
    backgroundColor: colors.accentBlue,
    shadowColor: colors.accentBlue,
  },
  micStatusLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: 'rgba(0, 0, 0, 0.4)',
    letterSpacing: 1,
    marginTop: 2,
  },
  infoCol: {
    flex: 0.8,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: spacing.md,
    maxHeight: '75%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#E4E7EC',
    paddingBottom: spacing.md,
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1A1A1C',
  },
  modalCloseBtn: {
    padding: 4,
  },
  languagesList: {
    marginBottom: spacing.xl,
  },
  languageItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E7EC',
  },
  languageItemText: {
    fontSize: 15,
    color: '#1A1A1C',
    fontWeight: '600',
  },
  languageItemNative: {
    fontSize: 13,
    color: 'rgba(0, 0, 0, 0.4)',
  },
  historyContainer: {
    flex: 1,
    backgroundColor: '#F8F9FA',
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: '#ECEEF1',
    backgroundColor: '#FFFFFF',
  },
  historyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1A1A1C',
  },
  closeBtn: {
    padding: 6,
  },
  emptyHistory: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyHistoryTxt: {
    fontSize: 15,
    color: 'rgba(0, 0, 0, 0.4)',
    textAlign: 'center',
    marginTop: spacing.md,
  },
  historyList: {
    padding: spacing.md,
    gap: spacing.md,
  },
  historyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    padding: spacing.md,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 4,
    elevation: 1,
  },
  historyCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  langPill: {
    backgroundColor: 'rgba(92, 107, 192, 0.1)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  langPillTxt: {
    fontSize: 10,
    fontWeight: '700',
    color: '#5C6BC0',
    textTransform: 'uppercase',
  },
  historyTime: {
    fontSize: 11,
    color: 'rgba(0, 0, 0, 0.4)',
  },
  historyTextContainer: {
    marginBottom: spacing.md,
    gap: 8,
  },
  historyTextOriginal: {
    fontSize: 15,
    lineHeight: 22,
    color: 'rgba(0, 0, 0, 0.6)',
    fontWeight: '400',
  },
  historyTextTranslated: {
    fontSize: 16,
    lineHeight: 24,
    color: '#1A1A1C',
    fontWeight: '500',
  },
  historyDivider: {
    height: 1,
    backgroundColor: '#E4E7EC',
    marginVertical: 2,
  },
  historyActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.08)',
  },
  actionTxt: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1A1A1C',
  },
  actionCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.08)',
  },
});
