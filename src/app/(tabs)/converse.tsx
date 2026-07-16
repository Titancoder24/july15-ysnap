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
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useAppAudioRecorder } from '../../utils/audioRecorder';
import { AudioModule, useAudioPlayer } from 'expo-audio';
import { elevenLabsService } from '../../services/elevenLabs';
import { getLanguageName, languages } from '../../constants/languages';

const { width } = Dimensions.get('window');

interface DictationTurn {
  id: string;
  text: string;
  detectedLanguage: string;
  detectedLanguageName: string;
  originalAudioUrl?: string;
  translatedAudioUrl?: string; // TTS playback url
  createdAt: string;
}

export default function ConverseTab() {
  const router = useRouter();
  const { user } = useAuth();

  // Media players & recorders
  const player = useAudioPlayer();
  const recorder = useAppAudioRecorder();

  // App State
  const [text, setText] = useState<string>('');
  const [detectedLangCode, setDetectedLangCode] = useState<string>('');
  const [detectedLangName, setDetectedLangName] = useState<string>('');
  
  const [isRecording, setIsRecording] = useState(false);
  const [processingState, setProcessingState] = useState<'idle' | 'recording' | 'transcribing' | 'speaking' | 'error'>('idle');
  const [statusText, setStatusText] = useState('');
  
  // Toggles
  const [vadEnabled, setVadEnabled] = useState(true);
  const [autoPlay, setAutoPlay] = useState(true);

  // History logs
  const [turns, setTurns] = useState<DictationTurn[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // VAD Stopwatch / silence detection emulator for client
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Sync profile voice
  const [profile, setProfile] = useState<any>(null);

  useEffect(() => {
    if (user) {
      supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single()
        .then(({ data }) => {
          if (data) setProfile(data);
        });
      
      // Load history
      loadHistory();
    }
  }, [user]);

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
          detectedLanguage: row.detected_language || '',
          detectedLanguageName: row.detected_language_name || 'English',
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
      // Insert into translation_items to integrate with the existing database schema
      const { error } = await supabase
        .from('translation_items')
        .insert({
          id: turn.id,
          user_id: user.id,
          speaker_id: 'A',
          sequence_number: turns.length + 1,
          source_text: turn.text,
          detected_language: turn.detectedLanguage || null,
          detected_language_name: turn.detectedLanguageName || null,
          source_language: turn.detectedLanguage,
          target_language: turn.detectedLanguage,
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

      // Create new turn object
      const newTurn: DictationTurn = {
        id: Math.random().toString(36).substring(7),
        text: result.text,
        detectedLanguage: langCode,
        detectedLanguageName: langName,
        originalAudioUrl: originalAudioUrl || undefined,
        createdAt: new Date().toISOString(),
      };

      setTurns(prev => [newTurn, ...prev]);

      // 3. Generate voice play-back in native language if autoPlay is enabled
      let translatedAudioUrl = '';
      if (autoPlay) {
        setProcessingState('speaking');
        setStatusText(`Playing back text...`);
        try {
          const ttsResult = await elevenLabsService.generateSpeech(
            result.text,
            profile?.selected_voice_id || '21m00Tcm4TlvDq8ikWAM',
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

      // 4. Save turn to database
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

  const handleCopyText = async () => {
    if (!text) return;
    Clipboard.setString(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('Copied', 'Transcribed text copied to clipboard.');
  };

  const handleShareText = async () => {
    if (!text) return;
    try {
      await Share.share({
        message: text,
      });
    } catch (e) {
      console.error("Error sharing text:", e);
    }
  };

  const handlePlayTTS = async () => {
    if (!text) return;
    setProcessingState('speaking');
    setStatusText('Generating audio speech...');
    try {
      const ttsResult = await elevenLabsService.generateSpeech(
        text,
        profile?.selected_voice_id || '21m00Tcm4TlvDq8ikWAM',
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
    setDetectedLangCode('');
    setDetectedLangName('');
    setProcessingState('idle');
    setStatusText('');
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.headerBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </Pressable>
        <Text style={styles.headerTitle}>YSnap dictation</Text>
        <Pressable style={styles.headerBtn} onPress={() => setShowHistory(true)}>
          <Ionicons name="time-outline" size={24} color="#FFFFFF" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContainer} keyboardShouldPersistTaps="handled">
        {/* Editor Board Card */}
        <View style={styles.dictationBoard}>
          {/* Detected Language Indicator Banner */}
          {detectedLangName ? (
            <View style={styles.detectedBadgeRow}>
              <Ionicons name="earth" size={16} color={colors.accentBlue} style={{ marginRight: 6 }} />
              <Text style={styles.detectedBadgeText}>Detected Language: <Text style={{ color: colors.accentBlue, fontWeight: '700' }}>{detectedLangName}</Text></Text>
            </View>
          ) : (
            <View style={styles.detectedBadgeRow}>
              <Ionicons name="sparkles" size={16} color="rgba(255, 255, 255, 0.4)" style={{ marginRight: 6 }} />
              <Text style={styles.detectedBadgePlaceholder}>Auto-detecting voice language...</Text>
            </View>
          )}

          {/* Text Area */}
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
              <Text style={styles.dictatedText}>{text}</Text>
            ) : (
              <Text style={styles.placeholderText}>
                Speak in Tamil, English, Hindi, Kannada, Telugu, Malayalam, Japanese, Spanish, or any other majority language. 
                {"\n\n"}YSnap will auto-verify the voice, transcribe the text instantly, and log it in its original language.
              </Text>
            )}
          </ScrollView>

          {/* Editor Action Buttons */}
          {text ? (
            <View style={styles.boardActionsRow}>
              <Pressable style={styles.boardActionBtn} onPress={handleCopyText}>
                <Ionicons name="copy-outline" size={18} color="#FFFFFF" />
                <Text style={styles.boardActionTxt}>Copy</Text>
              </Pressable>

              <Pressable style={styles.boardActionBtn} onPress={handleShareText}>
                <Ionicons name="share-outline" size={18} color="#FFFFFF" />
                <Text style={styles.boardActionTxt}>Share</Text>
              </Pressable>

              <Pressable style={styles.boardActionBtn} onPress={handlePlayTTS}>
                <Ionicons name="volume-medium-outline" size={18} color="#FFFFFF" />
                <Text style={styles.boardActionTxt}>Speak</Text>
              </Pressable>

              <Pressable style={[styles.boardActionBtn, { backgroundColor: 'rgba(239, 83, 80, 0.2)' }]} onPress={handleClearText}>
                <Ionicons name="trash-outline" size={18} color={colors.error} />
                <Text style={[styles.boardActionTxt, { color: colors.error }]}>Clear</Text>
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
                trackColor={{ true: colors.accentBlue, false: 'rgba(255, 255, 255, 0.1)' }}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
            </View>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Voice Readback</Text>
              <Switch
                value={autoPlay}
                onValueChange={setAutoPlay}
                thumbColor={colors.accentBlue}
                trackColor={{ true: colors.accentBlue, false: 'rgba(255, 255, 255, 0.1)' }}
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
            <Ionicons name="mic-circle" size={32} color={isRecording ? colors.accentBlue : 'rgba(255, 255, 255, 0.2)'} />
          </View>
        </View>
      </ScrollView>

      {/* History Log Sheet Modal */}
      <Modal
        visible={showHistory}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowHistory(false)}
      >
        <SafeAreaView style={styles.historyContainer}>
          <View style={styles.historyHeader}>
            <Text style={styles.historyTitle}>Transcription History</Text>
            <Pressable onPress={() => setShowHistory(false)} style={styles.closeBtn}>
              <Ionicons name="close" size={24} color="#FFFFFF" />
            </Pressable>
          </View>

          {turns.length === 0 ? (
            <View style={styles.emptyHistory}>
              <Ionicons name="document-text-outline" size={64} color="rgba(255, 255, 255, 0.2)" />
              <Text style={styles.emptyHistoryTxt}>No voice transcriptions logged yet.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.historyList} showsVerticalScrollIndicator={false}>
              {turns.map((turn, index) => (
                <View key={turn.id || index} style={styles.historyCard}>
                  <View style={styles.historyCardHeader}>
                    <View style={styles.langPill}>
                      <Text style={styles.langPillTxt}>{turn.detectedLanguageName}</Text>
                    </View>
                    <Text style={styles.historyTime}>
                      {new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>

                  <Text style={styles.historyText}>{turn.text}</Text>

                  <View style={styles.historyActions}>
                    {turn.originalAudioUrl && (
                      <Pressable 
                        style={styles.actionBtn}
                        onPress={() => {
                          player.replace({ uri: turn.originalAudioUrl });
                          player.play();
                        }}
                      >
                        <Ionicons name="play-outline" size={14} color="#FFFFFF" style={{ marginRight: 4 }} />
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
                        Clipboard.setString(turn.text);
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        Alert.alert('Copied', 'Text copied to clipboard.');
                      }}
                    >
                      <Ionicons name="copy-outline" size={16} color="rgba(255, 255, 255, 0.6)" />
                    </Pressable>

                    <Pressable 
                      style={styles.actionCircle}
                      onPress={async () => {
                        try {
                          await Share.share({ message: turn.text });
                        } catch (e) {
                          console.error(e);
                        }
                      }}
                    >
                      <Ionicons name="share-social-outline" size={16} color="rgba(255, 255, 255, 0.6)" />
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
    backgroundColor: '#121214',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: '#202024',
    backgroundColor: '#121214',
  },
  headerBtn: {
    padding: 8,
  },
  headerTitle: {
    ...typography.bodyMedium,
    color: '#FFFFFF',
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  scrollContainer: {
    flexGrow: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  dictationBoard: {
    flex: 1,
    minHeight: 350,
    backgroundColor: '#1C1C1E',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#2C2C2E',
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  detectedBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#2C2C2E',
    paddingBottom: spacing.sm,
    marginBottom: spacing.sm,
  },
  detectedBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  detectedBadgePlaceholder: {
    fontSize: 12,
    fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.4)',
  },
  textContainer: {
    flex: 1,
    marginVertical: spacing.xs,
  },
  textScrollContent: {
    flexGrow: 1,
  },
  dictatedText: {
    fontSize: 20,
    lineHeight: 28,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  placeholderText: {
    fontSize: 16,
    lineHeight: 24,
    color: 'rgba(255, 255, 255, 0.35)',
    fontStyle: 'italic',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
  },
  loadingText: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: spacing.md,
  },
  boardActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#2C2C2E',
    paddingTop: spacing.md,
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  boardActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  boardActionTxt: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
    marginLeft: 6,
  },
  micControlCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1C1C1E',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#2C2C2E',
    padding: spacing.md,
    paddingVertical: 18,
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
    color: 'rgba(255, 255, 255, 0.65)',
  },
  micOrbContainer: {
    flex: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timerWrapper: {
    position: 'absolute',
    top: -24,
    backgroundColor: 'rgba(239, 83, 80, 0.15)',
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
    color: 'rgba(255, 255, 255, 0.4)',
    letterSpacing: 1,
    marginTop: 2,
  },
  infoCol: {
    flex: 0.8,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  historyContainer: {
    flex: 1,
    backgroundColor: '#121214',
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: '#202024',
  },
  historyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
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
    color: 'rgba(255, 255, 255, 0.4)',
    textAlign: 'center',
    marginTop: spacing.md,
  },
  historyList: {
    padding: spacing.md,
    gap: spacing.md,
  },
  historyCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2C2C2E',
    padding: spacing.md,
  },
  historyCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  langPill: {
    backgroundColor: 'rgba(92, 107, 192, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  langPillTxt: {
    fontSize: 10,
    fontWeight: '700',
    color: '#8F9BFF',
    textTransform: 'uppercase',
  },
  historyTime: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.45)',
  },
  historyText: {
    fontSize: 16,
    lineHeight: 24,
    color: '#FFFFFF',
    fontWeight: '400',
    marginBottom: spacing.md,
  },
  historyActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  actionTxt: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  actionCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
});
