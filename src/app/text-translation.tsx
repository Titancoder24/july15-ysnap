import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, Pressable, ScrollView, ActivityIndicator, Alert, SafeAreaView, KeyboardAvoidingView, Platform, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { supabase, callEdgeFunction } from '../lib/supabase';
import { colors } from '../constants/colors';
import { typography } from '../constants/typography';
import { getLanguageByCode, languages } from '../constants/languages';
import { Ionicons } from '@expo/vector-icons';
import { TactileButton } from '../components';

const CHAR_LIMIT = 500;

export default function TextTranslationScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [sourceText, setSourceText] = useState('');
  const [translationResult, setTranslationResult] = useState<{
    id?: string;
    translated: string;
    transliteration: string;
    alternatives: string[];
    notes: string;
  } | null>(null);
  
  const [translating, setTranslating] = useState(false);
  const [showTransliterationSheet, setShowTransliterationSheet] = useState(false);
  const [selectedSourceLanguage, setSelectedSourceLanguage] = useState<string | null>(null);
  const [selectedTargetLanguage, setSelectedTargetLanguage] = useState<string | null>(null);
  const [languagePicker, setLanguagePicker] = useState<'source' | 'target' | null>(null);
  const [languageSearch, setLanguageSearch] = useState('');

  // Kanban Study Board states
  const [selectedColumn, setSelectedColumn] = useState<'to_learn' | 'learning' | 'mastered'>('to_learn');
  const [editingBookmark, setEditingBookmark] = useState<any | null>(null);
  const [editTranslatedText, setEditTranslatedText] = useState('');
  const [editNote, setEditNote] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Fetch all text bookmarks dynamically
  const { data: bookmarks = [], refetch: refetchBookmarks } = useQuery<any[]>({
    queryKey: ['homeBookmarks', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('bookmarks')
        .select('*')
        .eq('user_id', user.id)
        .contains('tags', ['text'])
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });

  const currentBookmark = bookmarks.find(b => b.translation_item_id === translationResult?.id);
  const isBookmarked = !!currentBookmark;

  // Fetch profile
  const { data: profile } = useQuery<any>({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      return data;
    },
    enabled: !!user?.id,
  });

  const nativeCode = selectedSourceLanguage ?? profile?.native_language ?? 'en';
  const targetCode = selectedTargetLanguage ?? profile?.primary_target_language ?? 'es';
  const filteredLanguages = languages.filter((language) => {
    const query = languageSearch.trim().toLowerCase();
    return !query || language.name.toLowerCase().includes(query) ||
      language.nativeName.toLowerCase().includes(query) || language.code.toLowerCase().includes(query);
  });

  const selectLanguage = (code: string) => {
    if (languagePicker === 'source') {
      setSelectedSourceLanguage(code);
      if (code === targetCode) setSelectedTargetLanguage(nativeCode);
    } else {
      setSelectedTargetLanguage(code);
      if (code === nativeCode) setSelectedSourceLanguage(targetCode);
    }
    setLanguagePicker(null);
    setLanguageSearch('');
    setTranslationResult(null);
  };

  const handleTranslate = async () => {
    if (!sourceText.trim()) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setTranslating(true);

    try {
      const { data: translationResultData, error: transError } = await callEdgeFunction<{
        session_id: string;
        translation_item_id: string;
        translated_text: string;
        detected_language: string;
        transliteration?: string | null;
        alternatives?: string[];
        context_notes?: string;
      }>('translate-text', {
        source: nativeCode,
        target: targetCode,
        text: sourceText,
      });

      if (transError || !translationResultData) {
        throw transError || new Error('Failed to translate text.');
      }

      const translated = translationResultData.translated_text;
      const transliteration = translationResultData.transliteration || '';
      const alternatives = translationResultData.alternatives || [];
      const notes = translationResultData.context_notes || '';

      setTranslationResult({
        id: translationResultData.translation_item_id,
        translated,
        transliteration,
        alternatives,
        notes,
      });
      setTranslating(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const { data: currentUserData } = await supabase.auth.getUser();
      const currentUserId = user?.id || currentUserData.user?.id;
      if (currentUserId) queryClient.invalidateQueries({ queryKey: ['recentSessions', currentUserId] });
    } catch (e: any) {
      console.error(e);
      setTranslating(false);
      Alert.alert('Translation Error', e.message || 'Failed to connect to the translation engine. Please try again.');
    }
  };

  const handleBookmarkToggle = async () => {
    if (!translationResult) return;
    if (!user) {
      Alert.alert('Sign in Required', 'Bookmarking translations is only available for registered users.');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      if (isBookmarked && currentBookmark) {
        const { error } = await supabase
          .from('bookmarks')
          .delete()
          .eq('id', currentBookmark.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('bookmarks')
          .insert({
            user_id: user.id,
            translation_item_id: translationResult.id || null,
            source_text: sourceText,
            translated_text: translationResult.translated,
            source_language: nativeCode,
            target_language: targetCode,
            tags: ['text', 'kanban_to_learn'],
            note: translationResult.notes || '',
          } as any);
        if (error) throw error;
      }
      queryClient.invalidateQueries({ queryKey: ['homeBookmarks', user.id] });
    } catch (e) {
      console.error(e);
    }
  };

  const handleMoveColumn = async (bookmark: any, direction: 'left' | 'right') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    let currentStatus = 'to_learn';
    if (bookmark.tags.includes('kanban_learning')) currentStatus = 'learning';
    if (bookmark.tags.includes('kanban_mastered')) currentStatus = 'mastered';

    let newStatus = currentStatus;
    if (direction === 'right') {
      if (currentStatus === 'to_learn') newStatus = 'learning';
      else if (currentStatus === 'learning') newStatus = 'mastered';
    } else {
      if (currentStatus === 'mastered') newStatus = 'learning';
      else if (currentStatus === 'learning') newStatus = 'to_learn';
    }

    if (newStatus === currentStatus) return;

    const cleanTags = bookmark.tags.filter((t: string) => t !== 'text' && !t.startsWith('kanban_'));
    const newTags = ['text', `kanban_${newStatus}`, ...cleanTags];

    try {
      const { error } = await supabase
        .from('bookmarks')
        .update({ tags: newTags })
        .eq('id', bookmark.id);

      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['homeBookmarks', user?.id] });
    } catch (e) {
      console.error('Error shifting columns:', e);
    }
  };

  const handleMoveOrder = async (item: any, direction: 'up' | 'down') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    const columnItems = bookmarks.filter(b => {
      let status = 'to_learn';
      if (b.tags.includes('kanban_learning')) status = 'learning';
      if (b.tags.includes('kanban_mastered')) status = 'mastered';
      return status === selectedColumn;
    });

    const idx = columnItems.findIndex(b => b.id === item.id);
    if (idx === -1) return;

    let swapItem = null;
    if (direction === 'up' && idx > 0) {
      swapItem = columnItems[idx - 1];
    } else if (direction === 'down' && idx < columnItems.length - 1) {
      swapItem = columnItems[idx + 1];
    }

    if (!swapItem) return;

    try {
      const tempTime = item.created_at;
      
      const { error: err1 } = await supabase
        .from('bookmarks')
        .update({ created_at: swapItem.created_at })
        .eq('id', item.id);

      const { error: err2 } = await supabase
        .from('bookmarks')
        .update({ created_at: tempTime })
        .eq('id', swapItem.id);

      if (err1 || err2) throw err1 || err2;

      queryClient.invalidateQueries({ queryKey: ['homeBookmarks', user?.id] });
    } catch (e) {
      console.error('Error swapping positions:', e);
    }
  };

  const handleDeleteBookmark = async (bookmarkId: string) => {
    Alert.alert(
      'Delete Note',
      'Are you sure you want to remove this saved phrase?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            try {
              const { error } = await supabase
                .from('bookmarks')
                .delete()
                .eq('id', bookmarkId);
              if (error) throw error;
              queryClient.invalidateQueries({ queryKey: ['homeBookmarks', user?.id] });
            } catch (e) {
              console.error('Error deleting bookmark:', e);
            }
          }
        }
      ]
    );
  };

  const handleOpenEdit = (bookmark: any) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setEditingBookmark(bookmark);
    setEditTranslatedText(bookmark.translated_text || '');
    setEditNote(bookmark.note || '');
  };

  const handleSaveEdit = async () => {
    if (!editingBookmark) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIsSavingEdit(true);

    try {
      const { error } = await supabase
        .from('bookmarks')
        .update({
          translated_text: editTranslatedText,
          note: editNote,
        })
        .eq('id', editingBookmark.id);

      if (error) throw error;
      setEditingBookmark(null);
      queryClient.invalidateQueries({ queryKey: ['homeBookmarks', user?.id] });
    } catch (e) {
      console.error('Error editing note:', e);
      Alert.alert('Error', 'Failed to save changes.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const toLearnNotes = bookmarks.filter(b => !b.tags.includes('kanban_learning') && !b.tags.includes('kanban_mastered'));
  const learningNotes = bookmarks.filter(b => b.tags.includes('kanban_learning'));
  const masteredNotes = bookmarks.filter(b => b.tags.includes('kanban_mastered'));
  
  const currentNotes = selectedColumn === 'to_learn' ? toLearnNotes 
                     : selectedColumn === 'learning' ? learningNotes 
                     : masteredNotes;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView 
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <Pressable style={styles.backButton} onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
          </Pressable>
          <View style={styles.langPair}>
            <Pressable onPress={() => setLanguagePicker('source')} style={styles.languageButton}>
              <Text style={styles.langText}>{getLanguageByCode(nativeCode)?.name}</Text>
              <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
            </Pressable>
            <Ionicons name="arrow-forward" size={16} color={colors.textMuted} style={{ marginHorizontal: 8 }} />
            <Pressable onPress={() => setLanguagePicker('target')} style={styles.languageButton}>
              <Text style={styles.langText}>{getLanguageByCode(targetCode)?.name}</Text>
              <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
            </Pressable>
          </View>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Input Card */}
          <View style={styles.card}>
            <TextInput
              style={styles.textArea}
              placeholder="Type your phrase here..."
              placeholderTextColor={colors.textSubtle}
              multiline
              maxLength={CHAR_LIMIT}
              value={sourceText}
              onChangeText={setSourceText}
            />
            <View style={styles.cardFooter}>
              <Text style={styles.charCount}>{sourceText.length} / {CHAR_LIMIT}</Text>
              {sourceText.length > 0 && (
                <Pressable style={styles.clearButton} onPress={() => setSourceText('')}>
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </Pressable>
              )}
            </View>
          </View>

          {/* Action Trigger */}
          <TactileButton
            title="Translate"
            onPress={handleTranslate}
            loading={translating}
            disabled={!sourceText.trim()}
            style={styles.buttonSpacing}
          />

          {/* Results Area */}
          {translationResult && (
            <View style={styles.resultsContainer}>
              <Text style={styles.sectionHeader}>Translation</Text>
              
              <View style={styles.resultCard}>
                <View style={styles.resultHeader}>
                  <Text style={styles.resultLang}>{getLanguageByCode(targetCode)?.name}</Text>
                  <View style={styles.actionsRow}>
                    <Pressable style={styles.actionIcon} onPress={handleBookmarkToggle}>
                      <Ionicons 
                        name={isBookmarked ? 'bookmark' : 'bookmark-outline'} 
                        size={20} 
                        color={isBookmarked ? colors.accentPurple : colors.textMuted} 
                      />
                    </Pressable>
                    <Pressable style={styles.actionIcon} onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}>
                      <Ionicons name="volume-medium" size={20} color={colors.textMuted} />
                    </Pressable>
                  </View>
                </View>
                <Text style={styles.resultText}>{translationResult.translated}</Text>
                
                {/* Transliteration Link */}
                <Pressable 
                  style={styles.translitLink} 
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setShowTransliterationSheet(true);
                  }}
                >
                  <Ionicons name="volume-medium-outline" size={16} color={colors.accentPurple} style={{ marginRight: 4 }} />
                  <Text style={styles.translitLinkText}>Show phonetic pronunciation</Text>
                </Pressable>
              </View>

              {/* Context Notes Card */}
              {translationResult.notes && (
                <View style={styles.notesCard}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                    <Ionicons name="bulb-outline" size={16} color={colors.accentOrange} style={{ marginRight: 6 }} />
                    <Text style={styles.notesTitle}>Context Guidance</Text>
                  </View>
                  <Text style={styles.notesContent}>{translationResult.notes}</Text>
                </View>
              )}

              {/* Alternatives List */}
              {translationResult.alternatives && translationResult.alternatives.length > 0 && (
                <View style={styles.alternativesContainer}>
                  <Text style={styles.sectionHeader}>Alternatives</Text>
                  {translationResult.alternatives.map((alt, idx) => (
                    <View key={idx} style={styles.altCard}>
                      <Text style={styles.altText}>{alt}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Kanban Translation Study Board */}
          {user && (
            <View style={styles.kanbanSection}>
              <Text style={styles.sectionHeader}>Translation Study Board</Text>
              <View style={styles.kanbanTabs}>
                <Pressable 
                  style={[styles.kanbanTab, selectedColumn === 'to_learn' && styles.kanbanTabActive]}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSelectedColumn('to_learn');
                  }}
                >
                  <Text style={[styles.kanbanTabText, selectedColumn === 'to_learn' && styles.kanbanTabTextActive]}>
                    To Learn ({toLearnNotes.length})
                  </Text>
                </Pressable>

                <Pressable 
                  style={[styles.kanbanTab, selectedColumn === 'learning' && styles.kanbanTabActive]}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSelectedColumn('learning');
                  }}
                >
                  <Text style={[styles.kanbanTabText, selectedColumn === 'learning' && styles.kanbanTabTextActive]}>
                    Learning ({learningNotes.length})
                  </Text>
                </Pressable>

                <Pressable 
                  style={[styles.kanbanTab, selectedColumn === 'mastered' && styles.kanbanTabActive]}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSelectedColumn('mastered');
                  }}
                >
                  <Text style={[styles.kanbanTabText, selectedColumn === 'mastered' && styles.kanbanTabTextActive]}>
                    Mastered ({masteredNotes.length})
                  </Text>
                </Pressable>
              </View>

              {/* Sticky Notes Grid */}
              <View style={styles.stickyNotesList}>
                {currentNotes.length === 0 ? (
                  <View style={styles.emptyStickyContainer}>
                    <Ionicons name="documents-outline" size={40} color={colors.textMuted} style={{ marginBottom: 8 }} />
                    <Text style={styles.emptyStickyText}>No sticky notes here</Text>
                    <Text style={styles.emptyStickySub}>Translations you save will appear in this column.</Text>
                  </View>
                ) : (
                  currentNotes.map((note, index) => {
                    const rotAngle = index % 2 === 0 ? '1.5deg' : '-1.5deg';
                    const noteBg = selectedColumn === 'to_learn' ? '#FFF9C4' 
                                 : selectedColumn === 'learning' ? '#E3F2FD' 
                                 : '#E8F5E9';

                    return (
                      <View 
                        key={note.id} 
                        style={[
                          styles.stickyNote, 
                          { backgroundColor: noteBg, transform: [{ rotate: rotAngle }] }
                        ]}
                      >
                        <View style={styles.stickyTape} />

                        <View style={styles.stickyHeader}>
                          <Text style={styles.stickyLangCode}>
                            {note.source_language.toUpperCase()} → {note.target_language.toUpperCase()}
                          </Text>
                          <View style={styles.stickyOrderControls}>
                            <Pressable 
                              disabled={index === 0}
                              onPress={() => handleMoveOrder(note, 'up')}
                              style={styles.orderArrow}
                            >
                              <Ionicons name="chevron-up" size={14} color={index === 0 ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.6)'} />
                            </Pressable>
                            <Pressable 
                              disabled={index === currentNotes.length - 1}
                              onPress={() => handleMoveOrder(note, 'down')}
                              style={styles.orderArrow}
                            >
                              <Ionicons name="chevron-down" size={14} color={index === currentNotes.length - 1 ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.6)'} />
                            </Pressable>
                          </View>
                        </View>

                        <Text style={note.source_text.length > 50 ? styles.stickySourceTextSmall : styles.stickySourceText}>
                          {note.source_text}
                        </Text>
                        <Text style={note.translated_text.length > 50 ? styles.stickyTransTextSmall : styles.stickyTransText}>
                          {note.translated_text}
                        </Text>

                        {note.note ? (
                          <View style={styles.stickyCommentBox}>
                            <Text style={styles.stickyCommentLabel}>Note:</Text>
                            <Text style={styles.stickyCommentText}>{note.note}</Text>
                          </View>
                        ) : null}

                        <View style={styles.stickyFooter}>
                          <View style={styles.stickyNavButtons}>
                            {selectedColumn !== 'to_learn' && (
                              <Pressable 
                                style={styles.stickyNavBtn}
                                onPress={() => handleMoveColumn(note, 'left')}
                              >
                                <Ionicons name="chevron-back" size={14} color="rgba(0,0,0,0.6)" />
                              </Pressable>
                            )}
                            <Pressable 
                              style={styles.stickyActionBtn}
                              onPress={() => handleOpenEdit(note)}
                            >
                              <Ionicons name="pencil" size={12} color="rgba(0,0,0,0.6)" />
                            </Pressable>
                            <Pressable 
                              style={styles.stickyActionBtn}
                              onPress={() => handleDeleteBookmark(note.id)}
                            >
                              <Ionicons name="trash-outline" size={12} color="rgba(0,0,0,0.6)" />
                            </Pressable>
                            {selectedColumn !== 'mastered' && (
                              <Pressable 
                                style={styles.stickyNavBtn}
                                onPress={() => handleMoveColumn(note, 'right')}
                              >
                                <Ionicons name="chevron-forward" size={14} color="rgba(0,0,0,0.6)" />
                              </Pressable>
                            )}
                          </View>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Phonetic Pronunciation Bottom Sheet */}
      {showTransliterationSheet && (
        <View style={styles.bottomSheetOverlay}>
          <Pressable style={styles.dismissOverlay} onPress={() => setShowTransliterationSheet(false)} />
          <View style={styles.bottomSheetCard}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>How to Pronounce</Text>
              <Pressable onPress={() => setShowTransliterationSheet(false)}>
                <Ionicons name="close" size={22} color={colors.textPrimary} />
              </Pressable>
            </View>
            <View style={styles.sheetBody}>
              <Text style={styles.phoneticLabel}>PHONETIC ALIGNMENT</Text>
              <Text style={styles.phoneticText}>{translationResult?.transliteration}</Text>
              <Text style={styles.phoneticDesc}>
                Capitalized letters indicate where the stress / emphasis should be placed.
              </Text>
            </View>
          </View>
        </View>
      )}

      <Modal
        visible={languagePicker !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setLanguagePicker(null)}
      >
        <View style={styles.languageOverlay}>
          <View style={styles.languageSheet}>
            <View style={styles.sheetHeader}>
              <View>
                <Text style={styles.sheetTitle}>
                  {languagePicker === 'source' ? 'Choose source language' : 'Choose target language'}
                </Text>
                <Text style={styles.languageCount}>{languages.length} supported languages</Text>
              </View>
              <Pressable onPress={() => setLanguagePicker(null)}>
                <Ionicons name="close" size={22} color={colors.textPrimary} />
              </Pressable>
            </View>
            <TextInput
              value={languageSearch}
              onChangeText={setLanguageSearch}
              placeholder="Search language or code"
              placeholderTextColor={colors.textSubtle}
              style={styles.languageSearch}
              autoCapitalize="none"
            />
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {filteredLanguages.map((language) => {
                const selected = (languagePicker === 'source' ? nativeCode : targetCode) === language.code;
                return (
                  <Pressable
                    key={language.code}
                    style={[styles.languageRow, selected && styles.languageRowSelected]}
                    onPress={() => selectLanguage(language.code)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.languageName}>{language.name}</Text>
                      <Text style={styles.languageNative}>{language.nativeName} · {language.code}</Text>
                    </View>
                    {selected && <Ionicons name="checkmark-circle" size={20} color={colors.accentPurple} />}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Edit Sticky Note Modal */}
      <Modal
        visible={editingBookmark !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingBookmark(null)}
      >
        <View style={styles.editNoteOverlay}>
          <View style={styles.editNoteCard}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Edit Sticky Note</Text>
              <Pressable onPress={() => setEditingBookmark(null)}>
                <Ionicons name="close" size={22} color={colors.textPrimary} />
              </Pressable>
            </View>

            <View style={styles.editForm}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>TRANSLATED PHRASE</Text>
                <TextInput
                  style={styles.editTextInput}
                  value={editTranslatedText}
                  onChangeText={setEditTranslatedText}
                  multiline
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>CONTEXT / MEMORY NOTE</Text>
                <TextInput
                  style={[styles.editTextInput, { minHeight: 80 }]}
                  value={editNote}
                  onChangeText={setEditNote}
                  placeholder="e.g. Learned at dinner, use in polite situations"
                  placeholderTextColor={colors.textSubtle}
                  multiline
                />
              </View>

              <Pressable 
                style={[styles.saveEditBtn, isSavingEdit && { opacity: 0.7 }]} 
                onPress={handleSaveEdit}
                disabled={isSavingEdit}
              >
                {isSavingEdit ? (
                  <ActivityIndicator size="small" color={colors.textInverse} />
                ) : (
                  <Text style={styles.saveEditBtnText}>Save Sticky Note</Text>
                )}
              </Pressable>
            </View>
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
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  backButton: {
    padding: 4,
  },
  langPair: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  languageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
  },
  langText: {
    fontSize: 16,
    fontFamily: typography.bodySemibold.fontFamily,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  scrollContent: {
    padding: 20,
  },
  card: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    minHeight: 160,
    justifyContent: 'space-between',
  },
  textArea: {
    fontSize: 16,
    fontFamily: typography.body.fontFamily,
    color: colors.textPrimary,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  charCount: {
    fontSize: 12,
    fontFamily: typography.tabular.fontFamily,
    color: colors.textSubtle,
  },
  clearButton: {
    padding: 4,
  },
  translateButton: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 16,
  },
  translateButtonDisabled: {
    backgroundColor: colors.disabled,
  },
  translateButtonText: {
    fontSize: 16,
    fontFamily: typography.button.fontFamily,
    fontWeight: typography.button.fontWeight,
    color: colors.textInverse,
  },
  resultsContainer: {
    marginTop: 10,
  },
  sectionHeader: {
    fontSize: 14,
    fontFamily: typography.captionMedium.fontFamily,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 10,
  },
  resultCard: {
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  resultLang: {
    fontSize: 12,
    fontFamily: typography.captionMedium.fontFamily,
    fontWeight: '700',
    color: colors.textMuted,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  actionIcon: {
    padding: 4,
  },
  resultText: {
    fontSize: 18,
    fontFamily: typography.bodyMedium.fontFamily,
    color: colors.textPrimary,
    lineHeight: 24,
    marginBottom: 12,
  },
  translitLink: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  translitLinkText: {
    fontSize: 13,
    fontFamily: typography.bodyMedium.fontFamily,
    color: colors.accentPurple,
  },
  notesCard: {
    backgroundColor: colors.surfaceWarning,
    borderWidth: 1,
    borderColor: '#F9E5C9',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
  },
  notesTitle: {
    fontSize: 13,
    fontFamily: typography.bodySemibold.fontFamily,
    color: colors.warning,
  },
  notesContent: {
    fontSize: 13,
    fontFamily: typography.body.fontFamily,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  alternativesContainer: {
    marginBottom: 20,
  },
  altCard: {
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  altText: {
    fontSize: 14,
    fontFamily: typography.body.fontFamily,
    color: colors.textPrimary,
  },
  bottomSheetOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
    zIndex: 100,
  },
  dismissOverlay: {
    flex: 1,
  },
  bottomSheetCard: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: typography.heading4.fontFamily,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  sheetBody: {
    gap: 12,
  },
  phoneticLabel: {
    fontSize: 11,
    fontFamily: typography.captionMedium.fontFamily,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 1.5,
  },
  phoneticText: {
    fontSize: 22,
    fontFamily: typography.heading2.fontFamily,
    fontWeight: '700',
    color: colors.accentPurple,
  },
  phoneticDesc: {
    fontSize: 13,
    fontFamily: typography.body.fontFamily,
    color: colors.textSecondary,
    lineHeight: 18,
    marginTop: 4,
  },
  buttonSpacing: {
    marginTop: 16,
  },
  languageOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.overlay,
  },
  languageSheet: {
    maxHeight: '78%',
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 36,
  },
  languageCount: {
    marginTop: 3,
    fontSize: 12,
    color: colors.textMuted,
    fontFamily: typography.captionMedium.fontFamily,
  },
  languageSearch: {
    backgroundColor: colors.surfaceSoft,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.textPrimary,
    marginBottom: 12,
  },
  languageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 12,
    marginBottom: 4,
  },
  languageRowSelected: {
    backgroundColor: colors.surfaceSoft,
  },
  languageName: {
    fontSize: 15,
    fontFamily: typography.bodySemibold.fontFamily,
    color: colors.textPrimary,
  },
  languageNative: {
    marginTop: 2,
    fontSize: 12,
    fontFamily: typography.captionMedium.fontFamily,
    color: colors.textMuted,
  },
  kanbanSection: {
    marginTop: 30,
    marginBottom: 20,
  },
  kanbanTabs: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    padding: 4,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  kanbanTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  kanbanTabActive: {
    backgroundColor: colors.background,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 1,
  },
  kanbanTabText: {
    fontSize: 13,
    fontFamily: typography.bodyMedium.fontFamily,
    color: colors.textMuted,
  },
  kanbanTabTextActive: {
    color: colors.textPrimary,
    fontFamily: typography.bodySemibold.fontFamily,
    fontWeight: '700',
  },
  stickyNotesList: {
    gap: 20,
    paddingBottom: 40,
  },
  stickyNote: {
    borderRadius: 16,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 5,
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.05)',
    position: 'relative',
    overflow: 'visible',
  },
  stickyTape: {
    position: 'absolute',
    top: -10,
    alignSelf: 'center',
    width: 60,
    height: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.04)',
    zIndex: 5,
    transform: [{ rotate: '-3deg' }],
  },
  stickyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  stickyLangCode: {
    fontSize: 10,
    fontWeight: '700',
    color: 'rgba(0, 0, 0, 0.4)',
    letterSpacing: 1,
  },
  stickyOrderControls: {
    flexDirection: 'row',
    gap: 6,
  },
  orderArrow: {
    padding: 2,
  },
  stickySourceText: {
    fontSize: 16,
    fontWeight: '700',
    color: 'rgba(0, 0, 0, 0.8)',
    fontFamily: typography.bodySemibold.fontFamily,
    marginBottom: 4,
  },
  stickySourceTextSmall: {
    fontSize: 14,
    fontWeight: '700',
    color: 'rgba(0, 0, 0, 0.8)',
    fontFamily: typography.bodySemibold.fontFamily,
    marginBottom: 4,
  },
  stickyTransText: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.primary,
    fontFamily: typography.heading3.fontFamily,
    marginBottom: 12,
  },
  stickyTransTextSmall: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.primary,
    fontFamily: typography.heading3.fontFamily,
    marginBottom: 12,
  },
  stickyCommentBox: {
    backgroundColor: 'rgba(0, 0, 0, 0.03)',
    borderRadius: 10,
    padding: 10,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.02)',
  },
  stickyCommentLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: 'rgba(0,0,0,0.5)',
    marginBottom: 2,
  },
  stickyCommentText: {
    fontSize: 12,
    color: 'rgba(0,0,0,0.7)',
    lineHeight: 16,
    fontFamily: typography.body.fontFamily,
  },
  stickyFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: 'rgba(0, 0, 0, 0.05)',
    paddingTop: 10,
  },
  stickyNavButtons: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
  },
  stickyNavBtn: {
    padding: 4,
  },
  stickyActionBtn: {
    padding: 4,
  },
  emptyStickyContainer: {
    alignItems: 'center',
    paddingVertical: 40,
    opacity: 0.6,
  },
  emptyStickyText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textMuted,
    marginTop: 10,
  },
  emptyStickySub: {
    fontSize: 12,
    color: colors.textSubtle,
    textAlign: 'center',
    marginTop: 4,
    paddingHorizontal: 20,
  },
  editNoteOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.overlay,
  },
  editNoteCard: {
    width: '85%',
    backgroundColor: colors.background,
    borderRadius: 20,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 15,
    elevation: 10,
  },
  editForm: {
    gap: 16,
    marginTop: 10,
  },
  inputGroup: {
    gap: 6,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 1,
  },
  editTextInput: {
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.textPrimary,
    textAlignVertical: 'top',
  },
  saveEditBtn: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  saveEditBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textInverse,
  },
});
