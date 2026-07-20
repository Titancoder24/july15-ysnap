import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { colors } from '../constants/colors';
import { spacing, layout, shadows } from '../constants/spacing';
import { typography } from '../constants/typography';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { elevenLabsService, Voice } from '../services/elevenLabs';

export default function VoiceLibraryScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [accentFilter, setAccentFilter] = useState<'all' | 'us' | 'uk' | 'au' | 'es' | 'in'>('all');
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [isRealConnected, setIsRealConnected] = useState(false);

  // Setup real audio player hook
  const player = useAudioPlayer('');
  const status = useAudioPlayerStatus(player);

  // Fetch Cloned Voices from Supabase
  const { data: clonedVoices = [] } = useQuery<any[]>({
    queryKey: ['clonedVoices', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('voice_profiles')
        .select('*')
        .eq('user_id', user.id);
      
      if (error) throw error;
      return (data || []) as any[];
    },
    enabled: !!user?.id,
  });

  // Fetch ElevenLabs Voices dynamically
  const { data: elevenVoices = [], isLoading: isLoadingEleven } = useQuery<Voice[]>({
    queryKey: ['elevenVoices'],
    queryFn: async () => {
      try {
        const voices = await elevenLabsService.fetchVoices();
        setIsRealConnected(true);
        return voices;
      } catch (err) {
        console.error('Failed to fetch ElevenLabs voices:', err);
        setIsRealConnected(false);
        return [];
      }
    }
  });

  // Mutate User Preferred Voice
  const setPreferredVoiceMutation = useMutation<any, any, string>({
    mutationFn: async (voiceId: string) => {
      if (!user?.id) return;
      const { error } = await (supabase as any)
        .from('user_preferences')
        .update({ selected_voice_id: voiceId })
        .eq('user_id', user.id);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences', user?.id] });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Voice Updated', 'Preferred narration voice has been updated.');
    },
    onError: (err) => {
      Alert.alert('Error', err.message);
    }
  });

  const handlePlaySample = (voiceId: string, previewUrl: string | undefined) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    if (playingVoiceId === voiceId) {
      player.pause();
      setPlayingVoiceId(null);
    } else {
      if (!previewUrl) {
        Alert.alert('No Sample', 'This voice model does not have a preview clip.');
        return;
      }
      setPlayingVoiceId(voiceId);
      player.replace({ uri: previewUrl });
      player.play();
    }
  };

  useEffect(() => {
    const isFinished = status.duration > 0 
      ? status.currentTime >= status.duration - 0.2 
      : false;
    if (playingVoiceId && !status.playing && (isFinished || isNaN(status.duration) || status.duration === 0)) {
      setPlayingVoiceId(null);
    }
  }, [status.playing, status.currentTime, status.duration]);

  const stopAudio = () => {
    player.pause();
    setPlayingVoiceId(null);
  };

  const handleSelectVoice = (voiceId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPreferredVoiceMutation.mutate(voiceId);
  };

  const voicesToUse: Voice[] = elevenVoices.length > 0 ? elevenVoices : [
    { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade', preview_url: 'https://api.elevenlabs.io/v1/voices/21m00Tcm4TlvDq8ikWAM/previews', labels: { accent: 'us', gender: 'female' } },
    { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', category: 'premade', preview_url: undefined, labels: { accent: 'british', gender: 'male' } },
    { voice_id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', category: 'premade', preview_url: undefined, labels: { accent: 'australian', gender: 'male' } },
    { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', category: 'premade', preview_url: undefined, labels: { accent: 'british', gender: 'male' } },
    { voice_id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', category: 'premade', preview_url: undefined, labels: { accent: 'american', gender: 'female' } },
  ];

  const filteredVoices = voicesToUse.filter(v => {
    if (accentFilter === 'all') return true;
    const accent = v.labels?.accent?.toLowerCase() || '';
    return accent.includes(accentFilter);
  });

  const getAccentLabel = (voice: Voice) => {
    const acc = voice.labels?.accent || '';
    if (acc.toLowerCase().includes('us')) return 'US Accent';
    if (acc.toLowerCase().includes('uk') || acc.toLowerCase().includes('british')) return 'UK Accent';
    if (acc.toLowerCase().includes('au') || acc.toLowerCase().includes('australian')) return 'Aus Accent';
    if (acc.toLowerCase().includes('es') || acc.toLowerCase().includes('spanish')) return 'Spanish';
    if (acc.toLowerCase().includes('in') || acc.toLowerCase().includes('indian')) return 'Indian';
    return acc || 'System';
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Voice Library</Text>
        <View style={styles.spacerBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Status Indicator Banner */}
        <View style={styles.statusBanner}>
          <Text style={styles.statusBannerText}>
            {isLoadingEleven 
              ? 'Loading voices...' 
              : isRealConnected 
                ? 'Ready' 
                : !user 
                  ? 'Sign in for custom voices' 
                  : 'Unable to load voices'}
          </Text>
        </View>

        {/* Dynamic Clone Slots Quick Card */}
        <View style={styles.cloneQuickCard}>
          <View style={styles.cloneIconWrapper}>
            <Ionicons name="mic-outline" size={28} color={colors.textInverse} />
          </View>
          <View style={styles.cloneTextCol}>
            <Text style={styles.cloneCardTitle}>Voice Cloning Hub</Text>
            <Text style={styles.cloneCardDesc}>Clone your own voice using 60 seconds of samples for premium bilingual narration.</Text>
            
            <View style={styles.cloneBtnsRow}>
              <Pressable 
                style={({ pressed }) => [styles.cloneBtn, pressed && styles.buttonPressed, { backgroundColor: colors.accentPurple }]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  router.push('/voice-clone');
                }}
              >
                <Text style={styles.cloneBtnText}>Voice Clone</Text>
              </Pressable>
              
              <Pressable 
                style={({ pressed }) => [styles.cloneBtn, pressed && styles.buttonPressed, { backgroundColor: colors.accentBlue }]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  router.push('/voice-changer');
                }}
              >
                <Text style={styles.cloneBtnText}>Voice Changer</Text>
              </Pressable>
            </View>
          </View>
        </View>

        {/* Accent Selector Tabs */}
        <View style={styles.accentContainer}>
          <Text style={styles.sectionTitle}>FILTER BY ACCENT</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.accentRow}>
            {(['all', 'us', 'uk', 'au', 'es', 'in'] as const).map((accent) => (
              <Pressable
                key={accent}
                style={[styles.accentTab, accentFilter === accent && styles.accentTabActive]}
                onPress={() => {
                  Haptics.selectionAsync();
                  setAccentFilter(accent);
                }}
              >
                <Text style={[styles.accentTabText, accentFilter === accent && styles.accentTabTextActive]}>
                  {accent.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        {/* Custom Cloned Voices Listing */}
        {clonedVoices.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>YOUR CLONED VOICES ({clonedVoices.length})</Text>
            {clonedVoices.map((voice) => (
              <View key={voice.id} style={styles.voiceCard}>
                <View style={styles.voiceCardLeft}>
                  <View style={[styles.voiceAvatar, { backgroundColor: colors.accentOrange }]}>
                    <Text style={styles.voiceAvatarText}>CV</Text>
                  </View>
                  <View style={styles.voiceMeta}>
                    <Text style={styles.voiceName}>{voice.display_name}</Text>
                    <Text style={styles.voiceDesc}>Custom cloned voice • {voice.accent_info || 'US Accent'}</Text>
                  </View>
                </View>
                <View style={styles.voiceCardRight}>
                  <Pressable 
                    style={styles.selectBtn}
                    onPress={() => handleSelectVoice(voice.provider_voice_id)}
                    disabled={!voice.provider_voice_id}
                  >
                    <Text style={styles.selectBtnText}>Select</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* System Voices Listing */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SYSTEM VOICES ({filteredVoices.length})</Text>
          {isLoadingEleven ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 20 }} />
          ) : (
            filteredVoices.map((voice) => {
              const isPlaying = playingVoiceId === voice.voice_id;
              return (
                <View key={voice.voice_id} style={styles.voiceCard}>
                  <View style={styles.voiceCardLeft}>
                    {/* Play audio button */}
                    <Pressable 
                      style={[styles.playBtn, isPlaying && styles.playBtnActive]}
                      onPress={() => handlePlaySample(voice.voice_id, voice.preview_url)}
                    >
                      <Ionicons 
                        name={isPlaying ? 'square' : 'play'} 
                        size={16} 
                        color={isPlaying ? colors.textInverse : colors.primary} 
                      />
                    </Pressable>

                    <View style={styles.voiceMeta}>
                      <View style={styles.voiceTitleRow}>
                        <Text style={styles.voiceName}>{voice.name}</Text>
                        <View style={styles.tag}>
                          <Text style={styles.tagText}>{getAccentLabel(voice)}</Text>
                        </View>
                      </View>
                      <Text style={styles.voiceDesc}>{voice.category || 'Premade'}</Text>
                    </View>
                  </View>
                  <View style={styles.voiceCardRight}>
                    <Pressable 
                      style={styles.selectBtn}
                      onPress={() => handleSelectVoice(voice.voice_id)}
                    >
                      <Text style={styles.selectBtnText}>Use</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })
          )}
        </View>

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
  cloneQuickCard: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSelected,
    borderRadius: 20,
    padding: 18,
    marginBottom: 24,
    ...shadows.md,
  },
  cloneIconWrapper: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  cloneTextCol: {
    flex: 1,
  },
  cloneCardTitle: {
    ...typography.heading4,
    color: colors.textInverse,
    marginBottom: 4,
  },
  cloneCardDesc: {
    ...typography.small,
    color: colors.textSubtle,
    lineHeight: 16,
    marginBottom: 14,
  },
  cloneBtnsRow: {
    flexDirection: 'row',
  },
  cloneBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginRight: 10,
    ...shadows.sm,
  },
  cloneBtnText: {
    ...typography.smallMedium,
    color: colors.textInverse,
    fontWeight: '700',
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.97 }],
  },
  accentContainer: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: typography.captionMedium.fontFamily,
    fontWeight: typography.captionMedium.fontWeight,
    color: colors.accentPurple,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  accentRow: {
    flexDirection: 'row',
  },
  accentTab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    marginRight: 8,
  },
  accentTabActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  accentTabText: {
    ...typography.captionMedium,
    color: colors.textSecondary,
  },
  accentTabTextActive: {
    color: colors.textInverse,
    fontWeight: '700',
  },
  section: {
    marginBottom: 24,
  },
  voiceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 14,
    marginBottom: 8,
    ...shadows.sm,
  },
  voiceCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 12,
  },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.backgroundMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  playBtnActive: {
    backgroundColor: colors.primary,
  },
  voiceAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  voiceAvatarText: {
    ...typography.captionMedium,
    color: colors.textInverse,
    fontWeight: '700',
  },
  voiceMeta: {
    flex: 1,
  },
  voiceTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  voiceName: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
  },
  tag: {
    backgroundColor: colors.backgroundMuted,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 8,
  },
  tagText: {
    ...typography.small,
    fontSize: 8,
    color: colors.textSecondary,
    fontWeight: '700',
  },
  voiceDesc: {
    ...typography.caption,
    color: colors.textMuted,
  },
  playbackProgressBg: {
    height: 4,
    backgroundColor: colors.backgroundMuted,
    borderRadius: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  playbackProgressFill: {
    height: '100%',
    backgroundColor: colors.accentPurple,
    borderRadius: 2,
  },
  voiceCardRight: {
    justifyContent: 'center',
  },
  selectBtn: {
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  selectBtnText: {
    ...typography.captionMedium,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  statusBanner: {
    backgroundColor: colors.backgroundSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  statusBannerText: {
    ...typography.captionMedium,
    color: colors.textSecondary,
    fontWeight: '600',
  },
});
