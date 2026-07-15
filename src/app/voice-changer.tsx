import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, RecordingPresets, AudioModule } from 'expo-audio';
import { useAppAudioRecorder } from '../utils/audioRecorder';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { colors } from '../constants/colors';
import { spacing, layout, shadows } from '../constants/spacing';
import { typography } from '../constants/typography';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { elevenLabsService } from '../services/elevenLabs';

interface VoiceOption {
  id: string;
  name: string;
  accent: string;
}

export default function VoiceChangerScreen() {
  const router = useRouter();
  const { user } = useAuth();

  // Selected Target Voice
  const [selectedVoiceId, setSelectedVoiceId] = useState('CwhRBWXzGAHq8TQ4Fs17');

  // Flow status: 'idle' | 'recording' | 'processing' | 'ready'
  const [flowState, setFlowState] = useState<'idle' | 'recording' | 'processing' | 'ready'>('idle');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  
  // Real voice changer response details
  const [outputAudioUrl, setOutputAudioUrl] = useState<string | null>(null);
  const [sourceTranscript, setSourceTranscript] = useState('');
  const [isRealConnected, setIsRealConnected] = useState(false);

  // Playback Output state
  const [isPlayingOutput, setIsPlayingOutput] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);

  // Volume animation
  const [volumeBar, setVolumeBar] = useState<number[]>([10, 10, 10, 10, 10]);

  // Timers refs
  const recordIntervalRef = useRef<any>(null);
  const volumeIntervalRef = useRef<any>(null);

  // Expo Audio SDK 57 recorder & player hooks
  const recorder = useAppAudioRecorder();
  const player = useAudioPlayer(outputAudioUrl || '');

  // Fetch cloned voice profiles
  const { data: clonedVoices = [] } = useQuery<any[]>({
    queryKey: ['clonedVoices', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from('voice_profiles')
        .select('*')
        .eq('user_id', user.id);
      return (data || []) as any[];
    },
    enabled: !!user?.id,
  });

  const { data: systemVoices = [] } = useQuery({
    queryKey: ['elevenLabsVoices'],
    queryFn: () => elevenLabsService.fetchVoices(),
    enabled: !!user?.id,
  });

  const voiceOptions: VoiceOption[] = [
    ...systemVoices.slice(0, 20).map(voice => ({
      id: voice.voice_id,
      name: voice.name,
      accent: voice.labels?.accent || voice.category || 'System',
    })),
    ...clonedVoices.map(cv => ({
      id: cv.id,
      name: cv.display_name,
      accent: cv.accent_info || 'Cloned'
    }))
  ];

  useEffect(() => {
    return () => {
      if (recordIntervalRef.current) clearInterval(recordIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (isPlayingOutput && !player.playing && player.currentTime >= player.duration - 0.2) {
      setIsPlayingOutput(false);
    }
  }, [player.playing, player.currentTime]);

  const handleToggleRecord = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (!user) {
      Alert.alert(
        'Sign In Required',
        'Sign in to use live voice changer.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign In', onPress: () => router.replace('/(auth)/sign-in') }
        ]
      );
      return;
    }

    if (isRecording) {
      // Stop
      setIsRecording(false);
      if (recordIntervalRef.current) clearInterval(recordIntervalRef.current);
      if (volumeIntervalRef.current) clearInterval(volumeIntervalRef.current);
      setVolumeBar([10, 10, 10, 10, 10]);
      const completedUri = await recorder.stop();
      setRecordedUri(completedUri || recorder.uri);
      setFlowState('idle');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      // Start
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Microphone Access', 'Microphone permissions are required for voice changer.');
        return;
      }

      setIsRecording(true);
      setFlowState('recording');
      setRecordingSeconds(0);
      setRecordedUri(null);
      setOutputAudioUrl(null);
      setIsRealConnected(false);

      await recorder.record();

      recordIntervalRef.current = setInterval(async () => {
        setRecordingSeconds(prev => {
          if (prev >= 29) {
            // Auto stop at 30s
            handleStopRecording();
            return 30;
          }
          return prev + 1;
        });
      }, 1000);

      volumeIntervalRef.current = setInterval(() => {
        setVolumeBar(Array.from({ length: 5 }, () => Math.floor(Math.random() * 45) + 10));
      }, 100);
    }
  };

  const handleStopRecording = async () => {
    setIsRecording(false);
    if (recordIntervalRef.current) clearInterval(recordIntervalRef.current);
    if (volumeIntervalRef.current) clearInterval(volumeIntervalRef.current);
    setVolumeBar([10, 10, 10, 10, 10]);
    const completedUri = await recorder.stop();
    setRecordedUri(completedUri || recorder.uri);
    setFlowState('idle');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleConvertVoice = async () => {
    if (!recordedUri) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setFlowState('processing');
    setIsRealConnected(false);

    try {
      let targetVoiceId = selectedVoiceId;
      const matchingCloned = clonedVoices.find(cv => cv.id === selectedVoiceId);
      if (matchingCloned?.provider_voice_id) {
        targetVoiceId = matchingCloned.provider_voice_id;
      }

      console.log('Morphing audio with target voice ID:', targetVoiceId);
      const res = await elevenLabsService.changeVoice(recordedUri, targetVoiceId, true);
      
      if (res && res.url) {
        setOutputAudioUrl(res.url);
        setSourceTranscript(res.sourceText || 'Voice conversion completed');
        setIsRealConnected(true);
        setFlowState('ready');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        throw new Error('TTS Voice changer failed: no output url');
      }
    } catch (err: any) {
      console.error(err);
      Alert.alert('Voice Changer Failed', err.message || 'Error occurred while calling Edge Function.');
      setFlowState('idle');
    }
  };

  const handlePlayOutput = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (isPlayingOutput) {
      player.pause();
      setIsPlayingOutput(false);
    } else {
      if (outputAudioUrl) {
        player.replace({ uri: outputAudioUrl });
        player.play();
        setIsPlayingOutput(true);
      }
    }
  };

  const handleReset = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setFlowState('idle');
    setRecordedUri(null);
    setOutputAudioUrl(null);
    setSourceTranscript('');
    setIsRealConnected(false);
    player.pause();
    setIsPlayingOutput(false);
  };

  const handleDownloadOutput = async () => {
    if (!outputAudioUrl) return;
    try {
      if (Platform.OS === 'web') {
        const anchor = document.createElement('a');
        anchor.href = outputAudioUrl;
        anchor.download = `ysnap-voice-${Date.now()}.mp3`;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } else {
        const destination = `${FileSystem.cacheDirectory}ysnap-voice-${Date.now()}.mp3`;
        const downloaded = await FileSystem.downloadAsync(outputAudioUrl, destination);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(downloaded.uri, { mimeType: 'audio/mpeg', dialogTitle: 'Save transformed voice' });
        } else {
          Alert.alert('Saved', `Audio saved to ${downloaded.uri}`);
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Download Failed', error instanceof Error ? error.message : 'Could not save the transformed audio.');
    }
  };

  const selectedVoiceName = voiceOptions.find(v => v.id === selectedVoiceId)?.name || 'Selected voice';

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Speech Voice Changer</Text>
        <View style={styles.spacerBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        
        {/* Intro description */}
        <View style={styles.introCard}>
          <Text style={styles.introTitle}>Speech-to-Speech conversion</Text>
          <Text style={styles.introText}>
            Record a short voice clip, select a target voice below, and our AI models will re-synthesize your words retaining your pacing and tone, but utilizing the selected voice's physical vocal print.
          </Text>
        </View>



        {/* 1. Voice Selector */}
        {flowState !== 'processing' && flowState !== 'ready' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>SELECT TARGET VOICE MODEL</Text>
            <View style={styles.pickerGrid}>
              {voiceOptions.map(voice => {
                const active = selectedVoiceId === voice.id;
                return (
                  <Pressable
                    key={voice.id}
                    style={[styles.pickerBtn, active && styles.pickerBtnActive]}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setSelectedVoiceId(voice.id);
                    }}
                  >
                    <Ionicons 
                      name={active ? "checkmark-circle" : "ellipse-outline"} 
                      size={18} 
                      color={active ? colors.textInverse : colors.textMuted} 
                      style={{ marginBottom: 6 }}
                    />
                    <Text style={[styles.pickerBtnName, active && styles.pickerBtnNameActive]}>
                      {voice.name}
                    </Text>
                    <Text style={[styles.pickerBtnAccent, active && styles.pickerBtnAccentActive]}>
                      {voice.accent}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {/* 2. Recording panel */}
        {flowState === 'idle' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>RECORD YOUR SPEECH INPUT</Text>
            <View style={styles.recordCard}>
              <Text style={styles.recordText}>
                {recordedUri ? 'Audio recorded successfully! Ready to transform.' : 'Press below to record up to 30 seconds in any supported speech-to-speech language.'}
              </Text>
              
              {recordedUri && (
                <Pressable 
                  style={({ pressed }) => [styles.actionBtnPrimary, pressed && styles.buttonPressed, { backgroundColor: colors.accentPurple }]}
                  onPress={handleConvertVoice}
                >
                  <Text style={styles.actionBtnText}>Convert Voice Print</Text>
                  <Ionicons name="sparkles" size={16} color={colors.textInverse} style={{ marginLeft: 6 }} />
                </Pressable>
              )}

              <Pressable
                style={[styles.micBtn, isRecording && styles.micBtnActive]}
                onPress={handleToggleRecord}
              >
                <Ionicons name={isRecording ? 'stop' : 'mic'} size={32} color={colors.textInverse} />
              </Pressable>
            </View>
          </View>
        )}

        {/* Recording active state */}
        {flowState === 'recording' && (
          <View style={styles.section}>
            <View style={styles.recordCard}>
              <Text style={styles.recordActiveText}>LISTENING AND CAPTURING: {recordingSeconds}s</Text>
              <View style={styles.waveRow}>
                {volumeBar.map((vol, i) => (
                  <View key={i} style={[styles.waveBar, { height: vol, backgroundColor: colors.error }]} />
                ))}
              </View>
              <Pressable style={[styles.micBtn, styles.micBtnActive]} onPress={handleToggleRecord}>
                <Ionicons name="stop" size={32} color={colors.textInverse} />
              </Pressable>
            </View>
          </View>
        )}

        {/* 3. Processing pipeline */}
        {flowState === 'processing' && (
          <View style={styles.processingCard}>
            <ActivityIndicator size="large" color={colors.primary} style={{ marginBottom: 16 }} />
            <Text style={styles.processingTitle}>Re-synthesizing vocal prints...</Text>
            <Text style={styles.processingSub}>Passing source acoustics through our neural converter to output voice model '{selectedVoiceName}'.</Text>
          </View>
        )}

        {/* 4. Output speech result player */}
        {flowState === 'ready' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>TRANSFORMED VOCAL OUTPUT</Text>
            <View style={styles.outputCard}>
              <View style={styles.outputHeader}>
                <View style={styles.avatarMini}>
                  <Ionicons name="volume-high" size={20} color={colors.textInverse} />
                </View>
                <View style={styles.outputMeta}>
                  <Text style={styles.outputName}>Converted to {selectedVoiceName}</Text>
                  <Text style={styles.outputDesc}>Speech-to-Speech replication completed</Text>
                </View>
              </View>

              <View style={styles.audioPlayerBox}>
                <Pressable 
                  style={[styles.playBtn, isPlayingOutput && styles.playBtnActive]}
                  onPress={handlePlayOutput}
                >
                  <Ionicons 
                    name={isPlayingOutput ? 'stop' : 'play'} 
                    size={22} 
                    color={isPlayingOutput ? colors.textInverse : colors.primary} 
                  />
                </Pressable>
                
                <View style={styles.progressTimelineBg}>
                  <View style={[styles.progressTimelineFill, { width: `${playProgress}%` }]} />
                </View>
                <Text style={styles.playPercentText}>{playProgress}%</Text>
              </View>

              <View style={styles.transcriptLogCard}>
                <Text style={styles.logLabel}>ORIGINAL SPEECH LOG</Text>
                <Text style={styles.logText}>{sourceTranscript}</Text>
              </View>

              <View style={styles.btnRow}>
                <Pressable style={styles.outlineActionBtn} onPress={handleDownloadOutput}>
                  <Ionicons name="download-outline" size={16} color={colors.primary} style={{ marginRight: 6 }} />
                  <Text style={styles.outlineActionBtnText}>Download</Text>
                </Pressable>
                <Pressable style={styles.outlineActionBtn} onPress={handleReset}>
                  <Ionicons name="refresh" size={16} color={colors.primary} style={{ marginRight: 6 }} />
                  <Text style={styles.outlineActionBtnText}>Try another</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}

      </ScrollView>
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: {
    width: layout.touchTarget,
    height: layout.touchTarget,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  headerTitle: {
    ...typography.heading3,
    color: colors.textPrimary,
  },
  spacerBtn: {
    width: layout.touchTarget,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },
  introCard: {
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
  },
  introTitle: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    marginBottom: 4,
  },
  introText: {
    ...typography.caption,
    color: colors.textMuted,
    lineHeight: 18,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: typography.captionMedium.fontFamily,
    fontWeight: typography.captionMedium.fontWeight,
    color: colors.accentPurple,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  pickerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  pickerBtn: {
    width: '48%',
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    alignItems: 'center',
    ...shadows.sm,
  },
  pickerBtnActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  pickerBtnName: {
    ...typography.bodyMedium,
    color: colors.textPrimary,
  },
  pickerBtnNameActive: {
    color: colors.textInverse,
  },
  pickerBtnAccent: {
    ...typography.small,
    color: colors.textMuted,
    marginTop: 2,
  },
  pickerBtnAccentActive: {
    color: colors.textSubtle,
  },
  recordCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
    ...shadows.sm,
  },
  recordText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  recordActiveText: {
    ...typography.bodySemibold,
    color: colors.error,
    textAlign: 'center',
    marginBottom: 16,
  },
  actionBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 20,
    marginBottom: 20,
    ...shadows.md,
  },
  actionBtnText: {
    ...typography.buttonSmall,
    color: colors.textInverse,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  micBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...shadows.md,
  },
  micBtnActive: {
    backgroundColor: colors.error,
    transform: [{ scale: 1.1 }],
  },
  waveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 60,
    marginBottom: 20,
  },
  waveBar: {
    width: 6,
    marginHorizontal: 3,
    borderRadius: 3,
  },
  processingCard: {
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.sm,
  },
  processingTitle: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    marginBottom: 6,
  },
  processingSub: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 16,
  },
  outputCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    padding: 16,
    ...shadows.sm,
  },
  outputHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  avatarMini: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.accentPurple,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  outputMeta: {
    flex: 1,
  },
  outputName: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
  },
  outputDesc: {
    ...typography.caption,
    color: colors.textMuted,
  },
  audioPlayerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.backgroundSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 10,
    marginBottom: 16,
  },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    marginRight: 12,
    ...shadows.sm,
  },
  playBtnActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  progressTimelineBg: {
    flex: 1,
    height: 6,
    backgroundColor: colors.backgroundMuted,
    borderRadius: 3,
    marginRight: 10,
    overflow: 'hidden',
  },
  progressTimelineFill: {
    height: '100%',
    backgroundColor: colors.accentPurple,
    borderRadius: 3,
  },
  playPercentText: {
    ...typography.smallMedium,
    color: colors.textSecondary,
    width: 32,
    textAlign: 'right',
  },
  transcriptLogCard: {
    backgroundColor: colors.backgroundSoft,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  logLabel: {
    ...typography.smallMedium,
    fontSize: 9,
    color: colors.textSubtle,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  logText: {
    ...typography.body,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  btnRow: {
    flexDirection: 'row',
  },
  outlineActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  outlineActionBtnText: {
    ...typography.buttonSmall,
    color: colors.primary,
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
    alignSelf: 'flex-start',
    marginBottom: 20,
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
});
