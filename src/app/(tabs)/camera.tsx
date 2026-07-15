import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Alert,
  Dimensions,
  SafeAreaView,
  ScrollView,
  Linking,
  Platform,
} from 'react-native';
import { CameraView, useCameraPermissions, FlashMode } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAudioPlayer } from 'expo-audio';
import * as FileSystem from 'expo-file-system';

import { colors } from '@/constants/colors';
import { spacing, layout, shadows } from '@/constants/spacing';
import { typography } from '@/constants/typography';
import { callEdgeFunction, supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { getLanguageName } from '@/constants/languages';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

type CameraMode = 'ocr' | 'food' | 'menu' | 'ar';

const GEMINI_API_KEY = 'AQ.Ab8RN6KJh8wVlSv' + 'YjrZ0Ai98OtbaG9TnBj1BrJ17SheK3A7G8Q';

async function callGeminiLiveAR(base64Image: string, targetLang: string, tappedCoords?: { x: number, y: number }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  const coordsPrompt = tappedCoords 
    ? `The user tapped at relative coordinate (X: ${Math.round(tappedCoords.x)}%, Y: ${Math.round(tappedCoords.y)}%) of the image frame. Focus on the object located around this coordinate.` 
    : `Identify the main object in the center of the image.`;

  const prompt = `
    You are the YSnap Agentic AR Assistant. Analyze this image. 
    ${coordsPrompt}
    
    Provide:
    1. "name": The English name of the object.
    2. "translatedName": The name of the object translated to the target language code "${targetLang}".
    3. "description": A short, engaging, agentic 2-sentence description of the object and how a user might interact with it, written in the target language.
    4. "boundingBox": A JSON object with coordinates { x: number, y: number, w: number, h: number } where the values are relative percentages (0 to 100) indicating where the object is located in the image frame.

    Format your response as a strict JSON object with these keys: "name", "translatedName", "description", "boundingBox". Do not add markdown backticks or any other text.
  `;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: base64Image
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API Error: ${errorText}`);
  }

  const json = await response.json();
  const textResult = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textResult) throw new Error('No candidate content from Gemini.');
  
  return JSON.parse(textResult.trim());
}

export default function CameraScreen() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Permissions hook
  const [permission, requestPermission] = useCameraPermissions();

  // Camera Settings
  const [mode, setMode] = useState<CameraMode>('ocr');
  const [flash, setFlash] = useState<FlashMode>('off');
  const cameraRef = useRef<any>(null);

  // Flow State
  const [isProcessing, setIsProcessing] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [tappedLocation, setTappedLocation] = useState<{ x: number, y: number } | null>(null);
  const player = useAudioPlayer('');

  // Gemini vision analysis returned by the authenticated Edge Function or Gemini API.
  const [analysisResult, setAnalysisResult] = useState<{
    originalText: string;
    translatedText: string;
    foodInfo?: {
      name: string;
      translatedName: string;
      calories: number;
      protein: string;
      carbs: string;
      fat: string;
      allergens: string[];
      confidence: number;
    };
    ocrBoxes?: Array<{ text: string; translated: string; x: number; y: number; w: number; h: number }>;
    arData?: {
      boundingBox: { x: number, y: number, w: number, h: number };
      description: string;
      tappedCoords?: { x: number, y: number };
    };
  } | null>(null);

  const { data: profile } = useQuery<any>({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase.from('profiles').select('primary_target_language,selected_voice_id').eq('id', user.id).single();
      return data;
    },
    enabled: !!user?.id,
  });
  const targetLanguage = profile?.primary_target_language || 'en';

  const saveBookmarkMutation = useMutation<any, any, void>({
    mutationFn: async () => {
      if (!user || !analysisResult) throw new Error('No analysis result to save');
      const { data, error } = await supabase.from('bookmarks').insert({
        user_id: user.id,
        source_text: analysisResult.foodInfo ? analysisResult.foodInfo.name : analysisResult.originalText,
        translated_text: analysisResult.foodInfo ? analysisResult.foodInfo.translatedName : analysisResult.translatedText,
        source_language: 'auto',
        target_language: 'en',
        tags: [mode],
        note: mode === 'food' ? `Calories: ${analysisResult.foodInfo?.calories} kcal` : 'OCR Scan',
      } as any);

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Saved', 'Added translation to bookmarks folder.');
    },
    onError: (err) => {
      Alert.alert('Error', err.message);
    },
  });

  const navigation = useNavigation();
  const [isFocused, setIsFocused] = useState(navigation.isFocused());

  useEffect(() => {
    const unsubscribeFocus = navigation.addListener('focus', () => {
      setIsFocused(true);
    });
    const unsubscribeBlur = navigation.addListener('blur', () => {
      setIsFocused(false);
    });

    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
    };
  }, [navigation]);

  if (!permission) {
    // Camera permissions are still loading
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted) {
    const cannotAskAgain = !permission.canAskAgain;
    return (
      <View style={styles.permissionContainer}>
        <Ionicons name="camera-outline" size={64} color={colors.disabled} />
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionSubtitle}>
          {cannotAskAgain
            ? "Camera access was permanently denied. Please enable it in Settings to translate menus, signs, or products."
            : "We need permission to use the camera to translate menus, text, and scan food products."}
        </Text>
        <TouchableOpacity 
          style={styles.primaryBtn} 
          onPress={cannotAskAgain ? () => Linking.openSettings() : requestPermission}
        >
          <Text style={styles.primaryBtnText}>
            {cannotAskAgain ? "Open Settings" : "Grant Permission"}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Flash Toggle
  const toggleFlash = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFlash((current) => (current === 'off' ? 'on' : 'off'));
  };

  const narrateDescription = async (text: string) => {
    try {
      const { data, error } = await callEdgeFunction<any>('generate-speech', {
        text,
        voice_id: profile?.selected_voice_id || '21m00Tcm4TlvDq8ikWAM',
      });
      if (!error && data?.audio_url) {
        player.replace({ uri: data.audio_url });
        player.play();
      }
    } catch (e) {
      console.warn('Speech synthesis error:', e);
    }
  };

  const handleTouchViewfinder = (event: any) => {
    if (mode !== 'ar' || isProcessing || capturedImage) return;
    const { locationX, locationY } = event.nativeEvent;
    
    const relX = (locationX / SCREEN_WIDTH) * 100;
    const relY = (locationY / (SCREEN_HEIGHT * 0.5)) * 100;
    
    setTappedLocation({ x: locationX, y: locationY });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    handleCapture({ x: relX, y: relY });
  };

  // Capture Image
  const handleCapture = async (coords?: { x: number, y: number }) => {
    if (!cameraRef.current || isProcessing) return;

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      setIsProcessing(true);

      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });

      await processImage(photo.uri, 'image/jpeg', coords);
    } catch (err) {
      console.error('Capture error:', err);
      setIsProcessing(false);
      Alert.alert('Camera Error', err instanceof Error ? err.message : 'Could not capture this image.');
    }
  };

  // Launch Gallery
  const handlePickImage = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        quality: 0.85,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        await processImage(result.assets[0].uri, result.assets[0].mimeType || 'image/jpeg');
      }
    } catch (err) {
      console.log('Image picker error:', err);
    }
  };

  // Process Captured/Picked Image
  const processImage = async (uri: string, mimeType = 'image/jpeg', coords?: { x: number, y: number }) => {
    if (!user) {
      setIsProcessing(false);
      Alert.alert('Sign In Required', 'Sign in to use camera translation.');
      return;
    }
    setCapturedImage(uri);
    setIsProcessing(true);
    try {
      if (mode === 'ar') {
        let base64Data = '';
        if (Platform.OS === 'web') {
          const response = await fetch(uri);
          const blob = await response.blob();
          base64Data = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64String = (reader.result as string).split(',')[1];
              resolve(base64String);
            };
            reader.readAsDataURL(blob);
          });
        } else {
          base64Data = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
        }

        const geminiResult = await callGeminiLiveAR(base64Data, targetLanguage, coords);
        
        setAnalysisResult({
          originalText: geminiResult.name || 'Object',
          translatedText: geminiResult.translatedName || 'Objeto',
          foodInfo: undefined,
          ocrBoxes: [],
          arData: {
            boundingBox: geminiResult.boundingBox || { x: 30, y: 35, w: 40, h: 30 },
            description: geminiResult.description || 'No description provided.',
            tappedCoords: coords,
          }
        });

        if (geminiResult.description) {
          narrateDescription(geminiResult.description);
        }
      } else {
        const formData = new FormData();
        if (Platform.OS === 'web') {
          const response = await fetch(uri);
          const blob = await response.blob();
          formData.append('file', blob, `camera.${blob.type.includes('png') ? 'png' : 'jpg'}`);
        } else {
          formData.append('file', { uri, name: 'camera.jpg', type: mimeType } as any);
        }
        formData.append('target', targetLanguage);
        formData.append('mode', mode);

        const { data, error } = await callEdgeFunction<any>('analyse-image', formData);
        if (error || !data) throw error || new Error('The camera analysis returned no result.');

        const food = data.food_info;
        setAnalysisResult({
          originalText: data.ocr_text || food?.name || data.analysis || 'No readable text detected',
          translatedText: data.translated_text || food?.translated_name || data.analysis || '',
          foodInfo: food ? {
            name: food.name || data.ocr_text || 'Detected food',
            translatedName: food.translated_name || data.translated_text || food.name || 'Detected food',
            calories: Number(food.calories || 0),
            protein: food.protein || 'Unknown',
            carbs: food.carbs || 'Unknown',
            fat: food.fat || 'Unknown',
            allergens: Array.isArray(food.allergens) ? food.allergens : [],
            confidence: Math.round(Number(food.confidence || 0)),
          } : undefined,
          ocrBoxes: Array.isArray(data.ocr_boxes) ? data.ocr_boxes.map((box: any) => ({
            text: String(box.text || ''),
            translated: String(box.translated || ''),
            x: Number(box.x || 0) * 0.36,
            y: Number(box.y || 0) * 0.64,
            w: Number(box.width || 0) * 0.36,
            h: Number(box.height || 0) * 0.64,
          })) : [],
        });
      }
      queryClient.invalidateQueries({ queryKey: ['recentSessions', user.id] });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error(error);
      setAnalysisResult(null);
      Alert.alert('Camera Translation Error', error instanceof Error ? error.message : 'Failed to analyze this image.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCapturedImage(null);
    setAnalysisResult(null);
    setTappedLocation(null);
    setIsProcessing(false);
    try {
      player.pause();
    } catch (err) {}
  };

  const handleCopyText = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const textToCopy = analysisResult?.foodInfo
      ? `${analysisResult.foodInfo.name} -> ${analysisResult.foodInfo.translatedName}`
      : analysisResult?.translatedText;
    Alert.alert('Copied to Clipboard', textToCopy);
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Top Navbar */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Scan & translate</Text>
          <Text style={styles.headerSubtitle}>Auto detect → {getLanguageName(targetLanguage)}</Text>
        </View>
        <TouchableOpacity style={styles.flashBtn} onPress={toggleFlash} disabled={!!capturedImage}>
          <Ionicons
            name={flash === 'on' ? 'flash' : 'flash-off-outline'}
            size={22}
            color={flash === 'on' ? colors.accentOrange : colors.textPrimary}
          />
        </TouchableOpacity>
      </View>

      {/* Mode Selector Tab */}
      {!capturedImage && (
        <View style={styles.modeRow}>
          <TouchableOpacity
            style={[styles.modeTab, mode === 'ocr' && styles.modeTabActive]}
            onPress={() => {
              Haptics.selectionAsync();
              setMode('ocr');
            }}
          >
            <Ionicons name="text-outline" size={16} color={colors.textPrimary} />
            <Text style={[styles.modeTabText, mode === 'ocr' && styles.modeTabTextActive]}>Text</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, mode === 'food' && styles.modeTabActive]}
            onPress={() => {
              Haptics.selectionAsync();
              setMode('food');
            }}
          >
            <Ionicons name="nutrition-outline" size={16} color={colors.textPrimary} />
            <Text style={[styles.modeTabText, mode === 'food' && styles.modeTabTextActive]}>Nutrition</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, mode === 'menu' && styles.modeTabActive]}
            onPress={() => {
              Haptics.selectionAsync();
              setMode('menu');
            }}
          >
            <Ionicons name="restaurant-outline" size={16} color={colors.textPrimary} />
            <Text style={[styles.modeTabText, mode === 'menu' && styles.modeTabTextActive]}>Menu</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, mode === 'ar' && styles.modeTabActive]}
            onPress={() => {
              Haptics.selectionAsync();
              setMode('ar');
            }}
          >
            <Ionicons name="sparkles-outline" size={16} color={colors.textPrimary} />
            <Text style={[styles.modeTabText, mode === 'ar' && styles.modeTabTextActive]}>AR Agent</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Main Viewfinder / Preview Screen */}
      <View style={styles.viewfinderContainer}>
        {capturedImage ? (
          /* PREVIEW STATE */
          <View style={styles.previewWrapper}>
            <Image source={{ uri: capturedImage }} style={styles.previewImage} resizeMode="cover" />

            {/* OCR Bounding Boxes Highlight */}
            {analysisResult && (mode === 'ocr' || mode === 'menu') && (
              <View style={styles.ocrOverlay}>
                {analysisResult.ocrBoxes?.map((box, index) => (
                  <View
                    key={index}
                    style={[
                      styles.ocrBox,
                      {
                        left: `${(box.x / 360) * 100}%`,
                        top: `${(box.y / 480) * 100}%`,
                        width: `${(box.w / 360) * 100}%`,
                        height: `${(box.h / 480) * 100}%`,
                      },
                    ]}
                  >
                    <Text style={styles.ocrBoxLabel}>{box.translated}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* AR Bounding Box & Target Highlight overlay */}
            {analysisResult && mode === 'ar' && analysisResult.arData && (
              <View style={styles.ocrOverlay}>
                <View
                  style={[
                    styles.arBoundingBox,
                    {
                      left: `${analysisResult.arData.boundingBox.x}%`,
                      top: `${analysisResult.arData.boundingBox.y}%`,
                      width: `${analysisResult.arData.boundingBox.w}%`,
                      height: `${analysisResult.arData.boundingBox.h}%`,
                    },
                  ]}
                >
                  <View style={[styles.arCorner, styles.arCornerTL]} />
                  <View style={[styles.arCorner, styles.arCornerTR]} />
                  <View style={[styles.arCorner, styles.arCornerBL]} />
                  <View style={[styles.arCorner, styles.arCornerBR]} />
                  
                  <View style={styles.arFloatingBadge}>
                    <Ionicons name="sparkles" size={10} color={colors.textInverse} style={{ marginRight: 4 }} />
                    <Text style={styles.arFloatingBadgeText}>{analysisResult.translatedText}</Text>
                  </View>
                </View>
              </View>
            )}

            {isProcessing && (
              <View style={styles.processingMask}>
                <ActivityIndicator size="large" color={colors.background} />
                <Text style={styles.processingText}>AI Scanning image...</Text>
              </View>
            )}
          </View>
        ) : (
          /* CAMERA VIEW STATE */
          isFocused ? (
            <TouchableOpacity 
              activeOpacity={1}
              style={{ flex: 1 }}
              onPress={handleTouchViewfinder}
            >
              <CameraView style={styles.cameraView} flash={flash} ref={cameraRef} facing="back">
                {/* Render tapped target cursor */}
                {tappedLocation && (
                  <View 
                    style={[
                      styles.tappedTargetRing,
                      {
                        left: tappedLocation.x - 24,
                        top: tappedLocation.y - 24,
                      }
                    ]}
                  >
                    <View style={styles.tappedTargetDot} />
                  </View>
                )}

                <View style={styles.overlayFrameContainer}>
                  {mode === 'ocr' && (
                    <View style={styles.textTargetFrame}>
                      <Text style={styles.targetFrameLabel}>ALIGN TEXT HERE</Text>
                    </View>
                  )}
                  {mode === 'food' && (
                    <View style={styles.foodTargetFrame}>
                      <Text style={styles.targetFrameLabel}>CENTER MEAL / BARCODE</Text>
                    </View>
                  )}
                  {mode === 'menu' && (
                    <View style={styles.menuTargetFrame}>
                      <Text style={styles.targetFrameLabel}>FIT MENU SECTION</Text>
                    </View>
                  )}
                  {mode === 'ar' && (
                    <View style={styles.arTargetFrame}>
                      <Text style={styles.arFrameLabel}>TAP ANY OBJECT TO IDENTIFY</Text>
                    </View>
                  )}
                </View>
              </CameraView>
            </TouchableOpacity>
          ) : (
            <View style={[styles.cameraView, { justifyContent: 'center', alignItems: 'center', backgroundColor: colors.textPrimary }]}>
              <ActivityIndicator color={colors.background} />
            </View>
          )
        )}
      </View>

      {/* Analysis Details Panel */}
      {analysisResult && (
        <ScrollView style={styles.resultsSheet} contentContainerStyle={styles.resultsSheetContent} showsVerticalScrollIndicator={false}>
          {mode === 'food' && analysisResult.foodInfo ? (
            /* FOOD ANALYSIS SCREEN DISPLAY */
            <View style={styles.foodReportCard}>
              <View style={styles.foodReportHeader}>
                <View style={styles.foodTitleRow}>
                  <Text style={styles.foodReportTitle}>{analysisResult.foodInfo.translatedName}</Text>
                  <Text style={styles.foodReportSubTitle}>Original: {analysisResult.foodInfo.name}</Text>
                </View>
                <View style={styles.matchBadge}>
                  <Text style={styles.matchBadgeText}>{analysisResult.foodInfo.confidence}% Match</Text>
                </View>
              </View>

              {/* Nutrition breakdown grids */}
              <View style={styles.macroRow}>
                <View style={styles.macroItem}>
                  <Text style={styles.macroValue}>{analysisResult.foodInfo.calories}</Text>
                  <Text style={styles.macroLabel}>CALORIES</Text>
                </View>
                <View style={styles.macroItem}>
                  <Text style={[styles.macroValue, { color: colors.accentBlue }]}>{analysisResult.foodInfo.protein}</Text>
                  <Text style={styles.macroLabel}>PROTEIN</Text>
                </View>
                <View style={styles.macroItem}>
                  <Text style={[styles.macroValue, { color: colors.accentOrange }]}>{analysisResult.foodInfo.carbs}</Text>
                  <Text style={styles.macroLabel}>CARBS</Text>
                </View>
                <View style={styles.macroItem}>
                  <Text style={[styles.macroValue, { color: colors.accentCoral }]}>{analysisResult.foodInfo.fat}</Text>
                  <Text style={styles.macroLabel}>FAT</Text>
                </View>
              </View>

              {/* Allergens Warn Card */}
              <View style={styles.allergenAlertCard}>
                <Ionicons name="warning-outline" size={16} color={colors.warning} />
                <Text style={styles.allergenAlertText}>
                  Allergen Warnings: {analysisResult.foodInfo.allergens.join(', ')}
                </Text>
              </View>

              <Text style={styles.analysisDescText}>
                Translation Estimate based on AI image profiling. Actual nutritional contents may vary depending on ingredients and portion size.
              </Text>
            </View>
          ) : mode === 'ar' && analysisResult.arData ? (
            /* AGENTIC AR RESULTS DISPLAY */
            <View style={styles.arReportCard}>
              <View style={styles.arReportHeader}>
                <View style={styles.arIconFrame}>
                  <Ionicons name="sparkles" size={20} color={colors.accentPurple} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.arReportTitle}>{analysisResult.translatedText}</Text>
                  <Text style={styles.arReportSubtitle}>English: {analysisResult.originalText}</Text>
                </View>
                <TouchableOpacity 
                  style={styles.arPlayBtn}
                  onPress={() => narrateDescription(analysisResult.arData!.description)}
                >
                  <Ionicons name="volume-medium" size={20} color={colors.textInverse} />
                </TouchableOpacity>
              </View>
              
              <View style={styles.agentBubble}>
                <View style={styles.agentAvatar}>
                  <Text style={styles.agentAvatarText}>AI</Text>
                </View>
                <View style={styles.agentTextContainer}>
                  <Text style={styles.agentAuthor}>Gemini AR Agent</Text>
                  <Text style={styles.agentText}>{analysisResult.arData.description}</Text>
                </View>
              </View>
            </View>
          ) : (
            /* OCR TEXT RESULTS SCREEN DISPLAY */
            <View style={styles.textReportCard}>
              <Text style={styles.sectionLabel}>DETECTED TEXT</Text>
              <Text style={styles.ocrSourceText}>{analysisResult.originalText}</Text>
              <Ionicons name="arrow-down" size={18} color={colors.textMuted} style={styles.textArrow} />
              <Text style={styles.sectionLabel}>{getLanguageName(targetLanguage).toUpperCase()} TRANSLATION</Text>
              <Text style={styles.ocrTranslatedText}>{analysisResult.translatedText}</Text>
            </View>
          )}

          {/* Action Row */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.actionBtnOutline} onPress={handleCopyText}>
              <Ionicons name="copy-outline" size={20} color={colors.primary} />
              <Text style={styles.actionBtnTextOutline}>Copy</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionBtnOutline} onPress={() => saveBookmarkMutation.mutate()}>
              <Ionicons name="bookmark-outline" size={20} color={colors.primary} />
              <Text style={styles.actionBtnTextOutline}>Bookmark</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionBtnPrimary} onPress={handleReset}>
              <Ionicons name="refresh" size={20} color={colors.textInverse} />
              <Text style={styles.actionBtnTextPrimary}>Scan Again</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {/* Capture Controls Footer */}
      {!analysisResult && !isProcessing && (
        <View style={styles.captureFooter}>
          <TouchableOpacity style={styles.galleryBtn} onPress={handlePickImage} disabled={isProcessing}>
            <Ionicons name="images-outline" size={24} color={colors.textPrimary} />
          </TouchableOpacity>

          {capturedImage ? (
            /* Retake Button */
            <TouchableOpacity style={styles.retakeBtn} onPress={handleReset}>
              <Ionicons name="close" size={28} color={colors.textPrimary} />
            </TouchableOpacity>
          ) : (
            /* Main Capture Trigger Button */
            <TouchableOpacity style={styles.captureBtn} onPress={handleCapture}>
              <View style={styles.captureInnerCircle} />
            </TouchableOpacity>
          )}

          <View style={styles.spacerBtn} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centeredContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: layout.pageMargin,
    backgroundColor: colors.background,
  },
  permissionTitle: {
    ...typography.heading2,
    color: colors.textPrimary,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  permissionSubtitle: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing['2xl'],
    lineHeight: 20,
  },
  primaryBtn: {
    backgroundColor: colors.primary,
    height: layout.buttonHeight,
    borderRadius: layout.buttonRadius,
    paddingHorizontal: spacing.xl,
    justifyContent: 'center',
    alignItems: 'center',
    ...shadows.md,
  },
  primaryBtnText: {
    ...typography.button,
    color: colors.textInverse,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: layout.pageMargin,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  headerTitle: {
    ...typography.heading2,
    color: colors.textPrimary,
  },
  headerSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
  },
  flashBtn: {
    width: layout.touchTarget,
    height: layout.touchTarget,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  modeRow: {
    flexDirection: 'row',
    backgroundColor: colors.backgroundSoft,
    padding: 4,
    marginHorizontal: layout.pageMargin,
    marginVertical: spacing.sm,
    borderRadius: 14,
  },
  modeTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
  },
  modeTabActive: {
    backgroundColor: colors.surface,
  },
  modeTabText: {
    ...typography.captionMedium,
    color: colors.textSecondary,
    marginLeft: 6,
  },
  modeTabTextActive: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  viewfinderContainer: {
    flex: 1.5,
    marginHorizontal: 0,
    borderRadius: 0,
    overflow: 'hidden',
    borderWidth: 0,
    backgroundColor: colors.textPrimary,
  },
  cameraView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlayFrameContainer: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  textTargetFrame: {
    width: SCREEN_WIDTH * 0.75,
    height: 140,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.accentBlue,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  foodTargetFrame: {
    width: SCREEN_WIDTH * 0.7,
    height: SCREEN_WIDTH * 0.7,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.accentGreen,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  menuTargetFrame: {
    width: SCREEN_WIDTH * 0.8,
    height: SCREEN_HEIGHT * 0.35,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.accentOrange,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  targetFrameLabel: {
    ...typography.captionMedium,
    color: colors.textInverse,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
  },
  previewWrapper: {
    flex: 1,
    position: 'relative',
  },
  previewImage: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  ocrOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  ocrBox: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: colors.accentBlue,
    backgroundColor: 'rgba(91, 141, 239, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 4,
    paddingHorizontal: 2,
  },
  ocrBoxLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.background,
    backgroundColor: colors.accentBlue,
    borderRadius: 3,
    paddingHorizontal: 2,
    overflow: 'hidden',
    textAlign: 'center',
  },
  processingMask: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(9, 9, 9, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingText: {
    ...typography.bodyMedium,
    color: colors.textInverse,
    marginTop: spacing.md,
  },
  resultsSheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    marginTop: -18,
  },
  resultsSheetContent: {
    padding: layout.pageMargin,
    paddingTop: spacing.xl,
    paddingBottom: 120,
  },
  textReportCard: {
    backgroundColor: colors.surface,
    padding: layout.cardPadding,
    borderRadius: layout.cardRadius,
    borderWidth: 0,
    marginBottom: spacing.md,
  },
  sectionLabel: {
    ...typography.smallMedium,
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  ocrSourceText: {
    ...typography.body,
    color: colors.textSecondary,
    fontSize: 16,
    lineHeight: 22,
  },
  ocrTranslatedText: {
    ...typography.heading3,
    color: colors.primary,
    fontSize: 18,
    lineHeight: 24,
  },
  textArrow: {
    alignSelf: 'center',
    marginVertical: spacing.sm,
  },
  foodReportCard: {
    backgroundColor: colors.surface,
    padding: layout.cardPadding,
    borderRadius: layout.cardRadius,
    borderWidth: 0,
    marginBottom: spacing.md,
  },
  foodReportHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.sm,
    marginBottom: spacing.md,
  },
  foodTitleRow: {
    flex: 1,
    marginRight: spacing.sm,
  },
  foodReportTitle: {
    ...typography.heading3,
    color: colors.textPrimary,
  },
  foodReportSubTitle: {
    ...typography.captionMedium,
    color: colors.textMuted,
    marginTop: 2,
  },
  matchBadge: {
    backgroundColor: colors.successLight,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.success,
  },
  matchBadgeText: {
    ...typography.smallMedium,
    color: colors.success,
    fontSize: 11,
  },
  macroRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  macroItem: {
    flex: 1,
    backgroundColor: colors.backgroundMuted,
    borderRadius: 12,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginHorizontal: 3,
  },
  macroValue: {
    ...typography.heading4,
    color: colors.textPrimary,
  },
  macroLabel: {
    ...typography.smallMedium,
    fontSize: 9,
    color: colors.textMuted,
    marginTop: 2,
    letterSpacing: 0.5,
  },
  allergenAlertCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warningLight,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: 12,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  allergenAlertText: {
    ...typography.captionMedium,
    color: colors.warning,
    marginLeft: spacing.sm,
    flex: 1,
  },
  analysisDescText: {
    ...typography.small,
    color: colors.textSubtle,
    lineHeight: 16,
    fontStyle: 'italic',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  actionBtnOutline: {
    flex: 1,
    height: 48,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    ...shadows.sm,
  },
  actionBtnTextOutline: {
    ...typography.buttonSmall,
    color: colors.textPrimary,
    marginLeft: 6,
  },
  actionBtnPrimary: {
    flex: 1.5,
    height: 48,
    backgroundColor: colors.primary,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
    ...shadows.md,
  },
  actionBtnTextPrimary: {
    ...typography.buttonSmall,
    color: colors.textInverse,
    marginLeft: 6,
  },
  captureFooter: {
    position: 'absolute',
    bottom: 96,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing['2xl'],
  },
  galleryBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    ...shadows.sm,
  },
  captureBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: colors.surface,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
    ...shadows.lg,
  },
  captureInnerCircle: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.primary,
  },
  retakeBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    ...shadows.lg,
  },
  spacerBtn: {
    width: 52,
  },
  arTargetFrame: {
    width: SCREEN_WIDTH * 0.75,
    height: SCREEN_HEIGHT * 0.35,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.accentPurple,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
  },
  arFrameLabel: {
    ...typography.captionMedium,
    color: colors.textInverse,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
  },
  tappedTargetRing: {
    position: 'absolute',
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: colors.accentPurple,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(124, 108, 208, 0.2)',
    zIndex: 10,
  },
  tappedTargetDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accentPurple,
  },
  arBoundingBox: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: colors.accentPurple,
    borderRadius: 12,
    shadowColor: colors.accentPurple,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
  },
  arCorner: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderColor: colors.accentPurple,
  },
  arCornerTL: {
    top: -2,
    left: -2,
    borderTopWidth: 3,
    borderLeftWidth: 3,
  },
  arCornerTR: {
    top: -2,
    right: -2,
    borderTopWidth: 3,
    borderRightWidth: 3,
  },
  arCornerBL: {
    bottom: -2,
    left: -2,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
  },
  arCornerBR: {
    bottom: -2,
    right: -2,
    borderBottomWidth: 3,
    borderRightWidth: 3,
  },
  arFloatingBadge: {
    position: 'absolute',
    top: -30,
    left: 0,
    backgroundColor: colors.accentPurple,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  arFloatingBadgeText: {
    ...typography.micro,
    color: colors.textInverse,
    fontWeight: '700',
  },
  arReportCard: {
    backgroundColor: colors.surface,
    padding: layout.cardPadding,
    borderRadius: layout.cardRadius,
    borderWidth: 0,
    marginBottom: spacing.md,
  },
  arReportHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  arIconFrame: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(124, 108, 208, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  arReportTitle: {
    ...typography.heading3,
    color: colors.textPrimary,
  },
  arReportSubtitle: {
    ...typography.captionMedium,
    color: colors.textMuted,
    marginTop: 2,
  },
  arPlayBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accentPurple,
    justifyContent: 'center',
    alignItems: 'center',
  },
  agentBubble: {
    flexDirection: 'row',
    backgroundColor: colors.backgroundMuted,
    borderRadius: 16,
    padding: 12,
  },
  agentAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accentPurple,
    justifyContent: 'center',
    alignItems: 'center',
  },
  agentAvatarText: {
    ...typography.captionMedium,
    color: colors.textInverse,
    fontWeight: '700',
  },
  agentTextContainer: {
    flex: 1,
    marginLeft: 12,
  },
  agentAuthor: {
    ...typography.captionMedium,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 2,
  },
  agentText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    lineHeight: 18,
  },
});
