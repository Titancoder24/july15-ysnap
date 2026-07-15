import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight, Camera, ChevronRight, FileText, MessageCircleMore, Mic,
  AudioLines, Repeat2, Settings, Volume2,
} from 'lucide-react-native';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { colors, layout, spacing, typography } from '../../constants';
import { getLanguageByCode } from '../../constants/languages';
import { BrandLockup, DimensionalIcon } from '../../components';
import { AppIcon } from '../../components/ui/AppIcon';

const ACTIONS = [
  { title: 'Type', caption: 'Translate text', iconName: 'type' as const, route: '/text-translation' },
  { title: 'Voice', caption: 'Speak naturally', iconName: 'voice' as const, route: '/voice-translation' },
  { title: 'Camera', caption: 'Scan what you see', iconName: 'camera' as const, route: '/(tabs)/camera' },
  { title: 'Accent Changer', caption: 'Change your accent', iconName: 'speaker' as const, route: '/voice-changer' },
  { title: 'Voice Clone', caption: 'Clone your voice', iconName: 'voice' as const, route: '/voice-clone' },
] as const;

export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: profile, isLoading: isProfileLoading } = useQuery<any>({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      return data;
    },
    enabled: !!user?.id,
  });

  const { data: recentSessions = [], isLoading } = useQuery<any[]>({
    queryKey: ['recentSessions', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase.from('translation_sessions').select('*').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(3);
      return (data || []) as any[];
    },
    enabled: !!user?.id,
  });

  const swapLanguages = useMutation<any, any, void>({
    mutationFn: async () => {
      if (!profile || !user?.id) return;
      const { error } = await (supabase as any).from('profiles').update({
        native_language: profile.primary_target_language,
        primary_target_language: profile.native_language,
      }).eq('id', user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      Haptics.selectionAsync();
      queryClient.invalidateQueries({ queryKey: ['profile', user?.id] });
    },
  });

  const source = getLanguageByCode(profile?.native_language ?? 'en');
  const target = getLanguageByCode(profile?.primary_target_language ?? 'es');
  
  let greeting = 'Hi there';
  if (!isProfileLoading) {
    if (profile?.display_name) {
      greeting = `Hi, ${profile.display_name.split(' ')[0]}`;
    } else {
      greeting = 'Hi, YSnap user';
    }
  }

  const open = (route: string) => {
    Haptics.selectionAsync();
    router.push(route as any);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View>
          <BrandLockup size={22} style={{ marginBottom: 4 }} />
          <Text style={styles.title}>{greeting}</Text>
        </View>
        <Pressable style={styles.iconButton} onPress={() => open('/settings')} accessibilityLabel="Open settings">
          <Settings size={20} color={colors.textPrimary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.languageBar}>
          <Pressable style={styles.languageSide} onPress={() => open('/text-translation')}>
            <Text style={styles.languageCode}>{source?.code?.toUpperCase() || 'EN'}</Text>
            <Text style={styles.languageName} numberOfLines={1}>{source?.name || 'English'}</Text>
          </Pressable>
          <Pressable style={styles.swap} onPress={() => swapLanguages.mutate()} accessibilityLabel="Swap languages">
            <Repeat2 size={18} color={colors.textInverse} />
          </Pressable>
          <Pressable style={[styles.languageSide, styles.languageSideRight]} onPress={() => open('/text-translation')}>
            <Text style={styles.languageCode}>{target?.code?.toUpperCase() || 'ES'}</Text>
            <Text style={styles.languageName} numberOfLines={1}>{target?.name || 'Spanish'}</Text>
          </Pressable>
        </View>

        <Pressable style={({ pressed }) => [styles.voiceHero, pressed && styles.pressed]} onPress={() => open('/voice-translation')}>
          <View style={styles.heroCopy}>
            <View style={styles.heroBadge}>
              <AudioLines size={14} color={colors.textInverse} />
              <Text style={styles.heroBadgeText}>VOICE TRANSLATION</Text>
            </View>
            <Text style={styles.heroTitle}>Tap to speak</Text>
            <Text style={styles.heroSubtitle}>Speak naturally. YSnap will listen and translate.</Text>
          </View>
          <View style={styles.micOrb}>
            <Mic size={29} color={colors.primary} strokeWidth={2.2} />
          </View>
        </Pressable>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Translate your way</Text>
        </View>
        <View style={styles.actionGrid}>
          <View style={styles.actionRow}>
            {/* Card 1: Type */}
            <Pressable 
              style={({ pressed }) => [styles.actionCard, pressed && styles.cardPressed]} 
              onPress={() => open(ACTIONS[0].route)}
            >
              <DimensionalIcon
                icon={<AppIcon name={ACTIONS[0].iconName} size={20} />}
                containerSize={42}
                style={{ marginBottom: spacing.sm }}
              />
              <Text style={styles.actionTitle}>{ACTIONS[0].title}</Text>
              <Text style={styles.actionCaption}>{ACTIONS[0].caption}</Text>
              <ArrowRight size={17} color={colors.textSubtle} style={styles.actionArrow} />
            </Pressable>
            
            {/* Card 2: Voice */}
            <Pressable 
              style={({ pressed }) => [styles.actionCard, pressed && styles.cardPressed]} 
              onPress={() => open(ACTIONS[1].route)}
            >
              <DimensionalIcon
                icon={<AppIcon name={ACTIONS[1].iconName} size={20} />}
                containerSize={42}
                style={{ marginBottom: spacing.sm }}
              />
              <Text style={styles.actionTitle}>{ACTIONS[1].title}</Text>
              <Text style={styles.actionCaption}>{ACTIONS[1].caption}</Text>
              <ArrowRight size={17} color={colors.textSubtle} style={styles.actionArrow} />
            </Pressable>
          </View>

          <View style={styles.actionRow}>
            {/* Card 3: Camera */}
            <Pressable 
              style={({ pressed }) => [styles.actionCard, pressed && styles.cardPressed]} 
              onPress={() => open(ACTIONS[2].route)}
            >
              <DimensionalIcon
                icon={<AppIcon name={ACTIONS[2].iconName} size={20} />}
                containerSize={42}
                style={{ marginBottom: spacing.sm }}
              />
              <Text style={styles.actionTitle}>{ACTIONS[2].title}</Text>
              <Text style={styles.actionCaption}>{ACTIONS[2].caption}</Text>
              <ArrowRight size={17} color={colors.textSubtle} style={styles.actionArrow} />
            </Pressable>
            
            {/* Card 4: Accent Changer */}
            <Pressable 
              style={({ pressed }) => [styles.actionCard, pressed && styles.cardPressed]} 
              onPress={() => open(ACTIONS[3].route)}
            >
              <DimensionalIcon
                icon={<AppIcon name={ACTIONS[3].iconName} size={20} />}
                containerSize={42}
                style={{ marginBottom: spacing.sm }}
              />
              <Text style={styles.actionTitle}>{ACTIONS[3].title}</Text>
              <Text style={styles.actionCaption}>{ACTIONS[3].caption}</Text>
              <ArrowRight size={17} color={colors.textSubtle} style={styles.actionArrow} />
            </Pressable>
          </View>

          <View style={styles.actionRow}>
            {/* Card 5: Voice Clone */}
            <Pressable 
              style={({ pressed }) => [styles.actionCard, pressed && styles.cardPressed]} 
              onPress={() => open(ACTIONS[4].route)}
            >
              <DimensionalIcon
                icon={<AppIcon name={ACTIONS[4].iconName} size={20} />}
                containerSize={42}
                style={{ marginBottom: spacing.sm }}
              />
              <Text style={styles.actionTitle}>{ACTIONS[4].title}</Text>
              <Text style={styles.actionCaption}>{ACTIONS[4].caption}</Text>
              <ArrowRight size={17} color={colors.textSubtle} style={styles.actionArrow} />
            </Pressable>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent translations</Text>
          <Pressable onPress={() => open('/history')}><Text style={styles.seeAll}>See all</Text></Pressable>
        </View>

        {isLoading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : recentSessions.length ? (
          <View style={styles.recentGroup}>
            {recentSessions.map((session, index) => {
              const SessionIcon = session.session_type === 'voice' ? Mic : session.session_type === 'camera' ? Camera : FileText;
              return (
                <Pressable key={session.id} style={[styles.recentRow, index < recentSessions.length - 1 && styles.recentDivider]}
                  onPress={() => open(`/history?sessionId=${session.id}`)}>
                  <View style={styles.recentIcon}><SessionIcon size={18} color={colors.textPrimary} /></View>
                  <View style={styles.recentCopy}>
                    <Text style={styles.recentTitle} numberOfLines={1}>{session.title || 'Translation'}</Text>
                    <Text style={styles.recentMeta}>{session.source_language.toUpperCase()} → {session.target_language.toUpperCase()}</Text>
                  </View>
                  <ChevronRight size={18} color={colors.textSubtle} />
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Pressable style={styles.emptyState} onPress={() => open('/text-translation')}>
            <View style={styles.emptyIcon}><Volume2 size={20} color={colors.textPrimary} /></View>
            <View style={styles.emptyCopy}>
              <Text style={styles.emptyTitle}>Your translations will appear here</Text>
              <Text style={styles.emptyText}>Try translating a phrase to get started.</Text>
            </View>
            <ChevronRight size={18} color={colors.textSubtle} />
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: layout.pageMargin, paddingTop: spacing.sm, paddingBottom: spacing.md,
    width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center',
  },
  eyebrow: { ...typography.micro, color: colors.textMuted, marginBottom: 2 },
  title: { ...typography.heading1, color: colors.textPrimary },
  iconButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.backgroundSoft, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: layout.pageMargin, paddingBottom: 120, width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center' },
  languageBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.backgroundSoft, borderRadius: 18, padding: spacing.sm, marginBottom: spacing.sm },
  languageSide: { flex: 1, paddingHorizontal: spacing.xs },
  languageSideRight: { alignItems: 'flex-end' },
  languageCode: { ...typography.micro, color: colors.textMuted, marginBottom: 2 },
  languageName: { ...typography.label, color: colors.textPrimary, maxWidth: '100%' },
  swap: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  voiceHero: { minHeight: 178, borderRadius: 24, backgroundColor: colors.primary, padding: spacing.xl, flexDirection: 'row', alignItems: 'center', marginBottom: spacing['2xl'], overflow: 'hidden' },
  heroCopy: { flex: 1, paddingRight: spacing.md },
  heroBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: spacing.md },
  heroBadgeText: { ...typography.micro, color: 'rgba(255,255,255,0.68)' },
  heroTitle: { ...typography.heading1, color: colors.textInverse, marginBottom: spacing.xs },
  heroSubtitle: { ...typography.bodySmall, color: 'rgba(255,255,255,0.72)', maxWidth: 220 },
  micOrb: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  sectionTitle: { ...typography.heading3, color: colors.textPrimary },
  seeAll: { ...typography.label, color: colors.textSecondary },
  actionGrid: { flexDirection: 'column', gap: spacing.sm, marginBottom: spacing['2xl'] },
  actionRow: { flexDirection: 'row', gap: spacing.sm, width: '100%' },
  actionCard: {
    flex: 1,
    minHeight: 148,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderBottomWidth: 3,
    borderBottomColor: '#D4D4D8',
    position: 'relative',
    ...Platform.select({
      ios: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.04,
        shadowRadius: 3,
      },
      web: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.04,
        shadowRadius: 3,
      }
    })
  },
  actionTitle: { ...typography.label, fontSize: 15, color: '#171717', marginBottom: 2 },
  actionCaption: { ...typography.caption, color: '#71717A', paddingRight: 18 },
  actionArrow: { position: 'absolute', right: 14, bottom: 14 },
  recentGroup: { backgroundColor: colors.backgroundSoft, borderRadius: 18, paddingHorizontal: spacing.md },
  recentRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center' },
  recentDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderStrong },
  recentIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  recentCopy: { flex: 1, paddingHorizontal: spacing.sm },
  recentTitle: { ...typography.label, color: colors.textPrimary },
  recentMeta: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  emptyState: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.backgroundSoft, borderRadius: 18, padding: spacing.md, minHeight: 84 },
  emptyIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  emptyCopy: { flex: 1, paddingHorizontal: spacing.sm },
  emptyTitle: { ...typography.label, color: colors.textPrimary },
  emptyText: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  loader: { marginVertical: spacing.xl },
  pressed: { transform: [{ scale: 0.99 }], backgroundColor: colors.primaryPressed },
  cardPressed: {
    transform: [{ translateY: 2 }, { scale: 0.98 }],
    borderBottomWidth: 1,
    borderColor: '#D4D4D8',
    backgroundColor: '#FAFAFA',
  },
});
