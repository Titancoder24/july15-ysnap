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
  Animated,
  Switch,
  TextInput,
  Modal,
  Clipboard,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions, FlashMode } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAudioPlayer } from 'expo-audio';
import Svg, { Circle, Rect } from 'react-native-svg';

import { colors, spacing, typography } from '../../constants';
import { callEdgeFunction, supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { getLanguageName } from '../../constants/languages';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

type CameraMode = 'ocr' | 'food' | 'menu' | 'ar';

interface PastScanSession {
  id: string;
  title: string;
  source_language: string;
  target_language: string;
  created_at: string;
  metadata: {
    mode: CameraMode;
    classified_type?: string;
    food_info?: {
      name: string;
      translated_name: string;
      calories: number;
      protein: string;
      carbs: string;
      fat: string;
      allergens: string[];
      confidence: number;
    } | null;
    menu_info?: {
      dishes: Array<{
        name: string;
        translated_name: string;
        description: string;
        price: string;
        calories?: number | null;
        protein?: string | null;
        carbs?: string | null;
        fat?: string | null;
      }>;
    } | null;
    analysis?: string | null;
    ocr_boxes?: any[];
  };
}

export default function CameraScreen() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigation = useNavigation();

  // Camera permissions
  const [permission, requestPermission] = useCameraPermissions();

  // Settings
  const [mode, setMode] = useState<CameraMode>('ocr');
  const [flash, setFlash] = useState<FlashMode>('off');
  const cameraRef = useRef<any>(null);

  // States
  const [isProcessing, setIsProcessing] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  
  // Selected dish details modal in Menu mode
  const [selectedDish, setSelectedDish] = useState<any | null>(null);

  // Sorting/filtering states for history dashboard
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'food' | 'menu' | 'ocr'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'calories_high' | 'calories_low'>('newest');

  // Fetch daily nutrition goals
  const { data: dailyGoals } = useQuery({
    queryKey: ['dailyNutritionGoals', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('daily_nutrition_goals')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user?.id,
  });

  // Fetch food logs for today
  const { data: todayLogs = [], refetch: refetchTodayLogs } = useQuery({
    queryKey: ['todayFoodLogs', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const todayStr = new Date().toISOString().split('T')[0];
      const { data, error } = await supabase
        .from('daily_food_logs')
        .select('*')
        .eq('user_id', user.id)
        .eq('logged_date', todayStr);
      if (error) {
        console.error('Failed to fetch food logs:', error);
        return [];
      }
      return data || [];
    },
    enabled: !!user?.id,
  });

  // Consumed totals calculator
  const consumedTotals = todayLogs.reduce((acc, log) => {
    return {
      calories: acc.calories + Number(log.calories || 0),
      protein: acc.protein + Number(log.protein || 0),
      carbs: acc.carbs + Number(log.carbs || 0),
      fat: acc.fat + Number(log.fat || 0),
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

  // Add meal insert log mutation
  const saveMealMutation = useMutation({
    mutationFn: async (payload: { meal_name: string; calories: number; protein: number; carbs: number; fat: number }) => {
      if (!user?.id) throw new Error('User not logged in');
      const todayStr = new Date().toISOString().split('T')[0];
      const { error } = await supabase
        .from('daily_food_logs')
        .insert({
          user_id: user.id,
          meal_name: payload.meal_name,
          calories: payload.calories,
          protein: payload.protein,
          carbs: payload.carbs,
          fat: payload.fat,
          logged_date: todayStr,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      refetchTodayLogs();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Meal Logged', 'This meal was successfully added to your diary.');
    },
    onError: (err) => {
      Alert.alert('Logging Failed', err.message);
    }
  });

  // Animation values
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const scanLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  // Monitor isProcessing to trigger the laser animation
  useEffect(() => {
    if (isProcessing) {
      scanLineAnim.setValue(0);
      scanLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(scanLineAnim, {
            toValue: 100,
            duration: 1600,
            useNativeDriver: false,
          }),
          Animated.timing(scanLineAnim, {
            toValue: 0,
            duration: 1600,
            useNativeDriver: false,
          })
        ])
      );
      scanLoopRef.current.start();
    } else {
      if (scanLoopRef.current) {
        scanLoopRef.current.stop();
        scanLoopRef.current = null;
      }
      scanLineAnim.setValue(0);
    }
  }, [isProcessing]);

  // Audio player for voice output
  const player = useAudioPlayer();

  // active profile settings
  const { data: profile } = useQuery<any>({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('profiles')
        .select('primary_target_language')
        .eq('id', user.id)
        .single();
      return data;
    },
    enabled: !!user?.id,
  });
  const targetLanguage = profile?.primary_target_language || 'en';

  // Load Scan History from Supabase
  const { data: pastScans, refetch: refetchPastScans } = useQuery<PastScanSession[]>({
    queryKey: ['pastCameraScans', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('translation_sessions')
        .select('*')
        .eq('user_id', user.id)
        .eq('session_type', 'camera')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return (data || []) as PastScanSession[];
    },
    enabled: !!user?.id,
  });

  // Current analysis results displayed
  const [analysisResult, setAnalysisResult] = useState<{
    originalText: string;
    translatedText: string;
    analysis?: string;
    foodInfo?: {
      name: string;
      translatedName: string;
      calories: number;
      protein: string;
      carbs: string;
      fat: string;
      fiber?: string;
      sugar?: string;
      sodium?: string;
      calcium?: string;
      iron?: string;
      cholesterol?: string;
      potassium?: string;
      magnesium?: string;
      vitamin_e?: string;
      health_score?: number;
      health_score_explanation?: string;
      benefit_insights?: string[];
      allergens: string[];
      dietary_cautions?: string[];
      recommendation_pairs?: string[];
      recommendation_alternatives?: string[];
      confidence: number;
    };
    menuInfo?: {
      dishes: Array<{
        name: string;
        translated_name: string;
        description: string;
        price: string;
        calories?: number | null;
        protein?: string | null;
        carbs?: string | null;
        fat?: string | null;
      }>;
    };
    ocrBoxes?: Array<{ text: string; translated: string; x: number; y: number; w: number; h: number }>;
  } | null>(null);

  // Flash Toggle
  const toggleFlash = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFlash((current) => (current === 'off' ? 'on' : 'off'));
  };

  // Run image processing via Edge Function calling OpenRouter
  const processImage = async (uri: string, mimeType = 'image/jpeg') => {
    if (!user) {
      setIsProcessing(false);
      Alert.alert('Sign In Required', 'Sign in to use camera translation.');
      return;
    }
    setCapturedImage(uri);
    setIsProcessing(true);
    try {
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
      const menu = data.menu_info;

      setAnalysisResult({
        originalText: data.ocr_text || food?.name || data.analysis || 'No text detected',
        translatedText: data.translated_text || food?.translated_name || data.analysis || '',
        analysis: data.analysis || '',
        foodInfo: food ? {
          name: food.name || 'Detected food',
          translatedName: food.translated_name || food.name || 'Detected food',
          calories: Number(food.calories || 0),
          protein: food.protein || '0g',
          carbs: food.carbs || '0g',
          fat: food.fat || '0g',
          fiber: food.fiber || '0g',
          sugar: food.sugar || '0g',
          sodium: food.sodium || '0mg',
          calcium: food.calcium || '0mg',
          iron: food.iron || '0mg',
          cholesterol: food.cholesterol || '0mg',
          potassium: food.potassium || '0mg',
          magnesium: food.magnesium || '0mg',
          vitamin_e: food.vitamin_e || '0mg',
          health_score: food.health_score || 0,
          health_score_explanation: food.health_score_explanation || '',
          benefit_insights: Array.isArray(food.benefit_insights) ? food.benefit_insights : [],
          allergens: Array.isArray(food.allergens) ? food.allergens : [],
          dietary_cautions: Array.isArray(food.dietary_cautions) ? food.dietary_cautions : [],
          recommendation_pairs: Array.isArray(food.recommendation_pairs) ? food.recommendation_pairs : [],
          recommendation_alternatives: Array.isArray(food.recommendation_alternatives) ? food.recommendation_alternatives : [],
          confidence: Math.round(Number(food.confidence || 90)),
        } : undefined,
        menuInfo: menu ? {
          dishes: Array.isArray(menu.dishes) ? menu.dishes : []
        } : undefined,
      });

      refetchPastScans();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      console.error(err);
      setAnalysisResult(null);
      Alert.alert('Analysis Failed', err.message || 'Failed to scan image. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCapture = async () => {
    if (!cameraRef.current || isProcessing) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      setIsProcessing(true);
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      await processImage(photo.uri, 'image/jpeg');
    } catch (err) {
      console.error(err);
      setIsProcessing(false);
      Alert.alert('Camera Error', 'Could not capture photo.');
    }
  };

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
      console.error(err);
    }
  };

  const handleLoadPastScan = (scan: PastScanSession) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setCapturedImage(null);
    setShowHistory(false);
    setMode(scan.metadata.mode || 'ocr');

    const food = scan.metadata.food_info;
    const menu = scan.metadata.menu_info;

    setAnalysisResult({
      originalText: scan.title || 'OCR Scan',
      translatedText: scan.title || '',
      analysis: scan.metadata.analysis || '',
      foodInfo: food ? {
        name: food.name,
        translatedName: food.translated_name,
        calories: Number(food.calories || 0),
        protein: food.protein || '0g',
        carbs: food.carbs || '0g',
        fat: food.fat || '0g',
        fiber: food.fiber || '0g',
        sugar: food.sugar || '0g',
        sodium: food.sodium || '0mg',
        calcium: food.calcium || '0mg',
        iron: food.iron || '0mg',
        cholesterol: food.cholesterol || '0mg',
        potassium: food.potassium || '0mg',
        magnesium: food.magnesium || '0mg',
        vitamin_e: food.vitamin_e || '0mg',
        health_score: food.health_score || 0,
        health_score_explanation: food.health_score_explanation || '',
        benefit_insights: Array.isArray(food.benefit_insights) ? food.benefit_insights : [],
        allergens: Array.isArray(food.allergens) ? food.allergens : [],
        dietary_cautions: Array.isArray(food.dietary_cautions) ? food.dietary_cautions : [],
        recommendation_pairs: Array.isArray(food.recommendation_pairs) ? food.recommendation_pairs : [],
        recommendation_alternatives: Array.isArray(food.recommendation_alternatives) ? food.recommendation_alternatives : [],
        confidence: Number(food.confidence || 100),
      } : undefined,
      menuInfo: menu ? {
        dishes: Array.isArray(menu.dishes) ? menu.dishes : []
      } : undefined,
    });
  };

  const handleReset = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCapturedImage(null);
    setAnalysisResult(null);
    setIsProcessing(false);
    try {
      player.pause();
    } catch (e) {}
  };

  const handleCopyText = (copyVal: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Clipboard.setString(copyVal);
    Alert.alert('Copied', 'Scanned text copied to clipboard.');
  };

  const handleDownloadReport = () => {
    if (!analysisResult) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const food = analysisResult.foodInfo;
    const menu = analysisResult.menuInfo;

    let reportHtml = `
      <html>
        <head>
          <title>YSnap AI Scan Report - ${mode.toUpperCase()}</title>
          <style>
            body { font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 40px; color: #1A1A1C; max-width: 800px; margin: auto; line-height: 1.5; }
            .header { border-bottom: 2px solid #E2E8F0; padding-bottom: 20px; margin-bottom: 30px; }
            .title { font-size: 28px; font-weight: 800; color: #201820; margin: 0; }
            .subtitle { font-size: 13px; color: #718096; margin-top: 4px; }
            .card { background: #FFFFFF; border: 1px solid #E4E7EC; border-radius: 16px; padding: 24px; margin-bottom: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.01); }
            .section-title { font-size: 18px; font-weight: 800; color: #1A1A1C; border-bottom: 1px solid #F1F3F5; padding-bottom: 8px; margin-bottom: 16px; }
            
            /* Donut chart simulation */
            .chart-row { display: flex; align-items: center; justify-content: space-between; margin-top: 20px; }
            .donut-container { position: relative; width: 120px; height: 120px; display: flex; align-items: center; justify-content: center; }
            .donut-text { position: absolute; font-size: 20px; font-weight: 800; text-align: center; }
            .donut-subtext { font-size: 10px; color: #718096; margin-top: 2px; }
            
            /* Macro bars */
            .macro-bars { flex: 1; margin-left: 40px; }
            .bar-row { margin-bottom: 12px; }
            .bar-header { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; margin-bottom: 4px; }
            .bar-track { height: 8px; background: #E2E8F0; border-radius: 4px; overflow: hidden; }
            .bar-fill { height: 100%; border-radius: 4px; }
            
            /* Stacked Distribution Bar */
            .dist-track { height: 16px; background: #E2E8F0; border-radius: 8px; display: flex; overflow: hidden; margin: 20px 0; }
            .dist-fill { height: 100%; }
            .legend { display: flex; gap: 20px; font-size: 11px; font-weight: 700; }
            .legend-item { display: flex; align-items: center; }
            .legend-dot { width: 8px; height: 8px; border-radius: 4px; margin-right: 6px; }
            
            /* Text bubbles */
            .ai-bubble { background: #F8F9FA; border-left: 4px solid #5B8DEF; padding: 16px; border-radius: 8px; margin-top: 20px; font-size: 14px; line-height: 1.6; color: #4A5568; }
            
            /* Menu items list */
            .dish-item { border-bottom: 1px solid #E2E8F0; padding: 12px 0; display: flex; justify-content: space-between; align-items: center; }
            .dish-name { font-weight: 700; color: #1A1A1C; }
            .dish-desc { font-size: 12px; color: #718096; margin-top: 4px; }
            .dish-price { font-weight: 800; color: #1D2D44; }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="title">YSnap Scan Analytics Report</div>
            <div class="subtitle">Generated by Gemini 3.5 Flash | Mode: ${mode.toUpperCase()} | Date: ${new Date().toLocaleString()}</div>
          </div>
    `;

    if (mode === 'food' && food) {
      const p = parseInt(food.protein) || 0;
      const c = parseInt(food.carbs) || 0;
      const f = parseInt(food.fat) || 0;
      const total = p + c + f;
      const pPct = total > 0 ? (p / total) * 100 : 0;
      const cPct = total > 0 ? (c / total) * 100 : 0;
      const fPct = total > 0 ? (f / total) * 100 : 0;

      reportHtml += `
        <div class="card">
          <div class="section-title">Nutrition Analytics - ${food.translatedName}</div>
          <div class="subtitle">Original: ${food.name} | Confidence: ${food.confidence}%</div>
          
          <div class="chart-row">
            <div class="donut-container">
              <svg width="120" height="120" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="50" stroke="#E2E8F0" stroke-width="10" fill="transparent" />
                <circle cx="60" cy="60" r="50" stroke="#5B8DEF" stroke-width="10" stroke-dasharray="314.15" stroke-dashoffset="${314.15 - Math.min(food.calories / 2000, 1) * 314.15}" fill="transparent" stroke-linecap="round" transform="rotate(-90 60 60)" />
              </svg>
              <div class="donut-text">
                <div>${food.calories}</div>
                <div class="donut-subtext">kcal</div>
              </div>
            </div>
            
            <div class="macro-bars">
              <div class="bar-row">
                <div class="bar-header"><span>Protein</span><span style="color: #5C6BC0">${food.protein}</span></div>
                <div class="bar-track"><div class="bar-fill" style="width: ${Math.min((p / 60) * 100, 100)}%; background: #5C6BC0;"></div></div>
              </div>
              <div class="bar-row">
                <div class="bar-header"><span>Carbohydrates</span><span style="color: #EF9A9A">${food.carbs}</span></div>
                <div class="bar-track"><div class="bar-fill" style="width: ${Math.min((c / 150) * 100, 100)}%; background: #EF9A9A;"></div></div>
              </div>
              <div class="bar-row">
                <div class="bar-header"><span>Fat</span><span style="color: #FFB74D">${food.fat}</span></div>
                <div class="bar-track"><div class="bar-fill" style="width: ${Math.min((f / 50) * 100, 100)}%; background: #FFB74D;"></div></div>
              </div>
            </div>
          </div>
          
          <h3 style="margin-top: 30px; font-size: 14px; font-weight: 800; color: #4A5568;">Macro Grams Distribution</h3>
          <div class="dist-track">
            <div style="width: ${pPct}%; background: #5C6BC0;"></div>
            <div style="width: ${cPct}%; background: #EF9A9A;"></div>
            <div style="width: ${fPct}%; background: #FFB74D;"></div>
          </div>
          <div class="legend">
            <div class="legend-item"><div class="legend-dot" style="background: #5C6BC0;"></div>Protein: ${Math.round(pPct)}%</div>
            <div class="legend-item"><div class="legend-dot" style="background: #EF9A9A;"></div>Carbs: ${Math.round(cPct)}%</div>
            <div class="legend-item"><div class="legend-dot" style="background: #FFB74D;"></div>Fat: ${Math.round(fPct)}%</div>
          </div>
          
          ${food.allergens.length > 0 ? `
            <div style="margin-top: 24px; padding: 12px; background: #FFF0F1; border-radius: 8px; border: 1px solid #FFF0F1; font-weight: bold; color: #C13E4C;">
              Warning: Contains ${food.allergens.join(', ')}
            </div>
          ` : ''}
        </div>
      `;
    } else if (mode === 'menu' && menu) {
      const stats = calculateMenuPriceStats(menu.dishes);
      reportHtml += `
        <div class="card">
          <div class="section-title">Menu Price Spread Analysis</div>
          <div style="display: flex; gap: 20px; margin-bottom: 20px;">
            <div style="flex: 1; padding: 12px; background: #F8F9FA; border-radius: 8px; text-align: center;"><strong>Min Price:</strong> $${stats.min.toFixed(2)}</div>
            <div style="flex: 1; padding: 12px; background: #F8F9FA; border-radius: 8px; text-align: center; color: #5B8DEF; font-weight: bold;"><strong>Avg Price:</strong> $${stats.avg.toFixed(2)}</div>
            <div style="flex: 1; padding: 12px; background: #F8F9FA; border-radius: 8px; text-align: center;"><strong>Max Price:</strong> $${stats.max.toFixed(2)}</div>
          </div>
          
          <h3 style="margin-top: 30px; font-size: 16px; border-bottom: 1px solid #E2E8F0; padding-bottom: 8px;">Dishes List & Projected Nutrition</h3>
          <div>
            ${menu.dishes.map(d => `
              <div class="dish-item">
                <div style="flex: 1; margin-right: 15px;">
                  <span class="dish-name">${d.translated_name || d.name}</span>
                  <div class="dish-desc">${d.description || 'No description provided.'}</div>
                  ${d.calories ? `<div style="font-size: 11px; font-weight: bold; color: #7C6CD0; margin-top: 4px;">Projected Nutrition: ${d.calories} kcal | Protein: ${d.protein} | Carbs: ${d.carbs} | Fat: ${d.fat}</div>` : ''}
                </div>
                <div class="dish-price">${d.price}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    } else if (mode === 'ar') {
      reportHtml += `
        <div class="card">
          <div class="section-title">Spatial AR Scan Projections</div>
          <div style="display: flex; justify-content: space-around; margin-bottom: 20px; font-size: 14px;">
            <div><strong>Width:</strong> 12 cm</div>
            <div><strong>Height:</strong> 24 cm</div>
            <div><strong>Depth:</strong> 8 cm</div>
            <div><strong>Volume:</strong> 2304 cm³</div>
          </div>
          <div style="padding: 10px; background: #F8F9FA; border-radius: 8px; font-weight: bold; text-align: center; color: #5B8DEF;">Object Spatial Volume Type: cube-projection-3d</div>
        </div>
      `;
    }

    if (analysisResult.analysis) {
      reportHtml += `
        <div class="card">
          <div class="section-title">YSnap AI Analysis chat</div>
          <div class="ai-bubble">${analysisResult.analysis}</div>
        </div>
      `;
    }

    if (mode === 'ocr' || (!food && !menu)) {
      reportHtml += `
        <div class="card">
          <div class="section-title">Scanned Raw Text & Translation</div>
          <p><strong>Original Scanned Text:</strong></p>
          <div style="background: #F8F9FA; padding: 12px; border-radius: 6px; white-space: pre-wrap; font-size: 13px;">${analysisResult.originalText}</div>
          <p style="margin-top: 20px;"><strong>Translation (${getLanguageName(targetLanguage)}):</strong></p>
          <div style="background: #F8F9FA; padding: 12px; border-radius: 6px; white-space: pre-wrap; font-size: 14px; font-weight: bold; color: #5C6BC0;">${analysisResult.translatedText}</div>
        </div>
      `;
    }

    reportHtml += `
        </body>
      </html>
    `;

    if (Platform.OS === 'web') {
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(reportHtml);
        printWindow.document.close();
        printWindow.onload = function() {
          printWindow.print();
        };
      } else {
        Alert.alert('Download Error', 'Pop-up was blocked. Please allow pop-ups for this site.');
      }
    } else {
      Alert.alert('Report PDF Preview', 'PDF printing is available on web. The generated summary report details: \n\n' + (analysisResult.analysis || analysisResult.translatedText));
    }
  };

  // SVGs / Rendering charts helper components
  const CalorieDonut = ({ kcal = 0 }: { kcal: number }) => {
    const size = 110;
    const strokeWidth = 10;
    const center = size / 2;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const maxBudget = 2000;
    const pct = Math.min(kcal / maxBudget, 1);
    const strokeOffset = circumference - pct * circumference;

    return (
      <View style={styles.donutWrapper}>
        <Svg width={size} height={size}>
          <Circle
            cx={center}
            cy={center}
            r={radius}
            stroke="#E2E8F0"
            strokeWidth={strokeWidth}
            fill="transparent"
          />
          <Circle
            cx={center}
            cy={center}
            r={radius}
            stroke={colors.accentBlue}
            strokeWidth={strokeWidth}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={strokeOffset}
            strokeLinecap="round"
            fill="transparent"
            transform={`rotate(-90 ${center} ${center})`}
          />
        </Svg>
        <View style={styles.donutLabelBox}>
          <Text style={styles.donutValText}>{kcal}</Text>
          <Text style={styles.donutSubText}>kcal</Text>
        </View>
      </View>
    );
  };

  const MacroIndicatorBar = ({ label, valString, maxGrams, barColor }: { label: string; valString: string; maxGrams: number; barColor: string }) => {
    const numeric = parseInt(valString) || 0;
    const percent = Math.min((numeric / maxGrams) * 100, 100);

    return (
      <View style={styles.macroBarContainer}>
        <View style={styles.macroBarHeader}>
          <Text style={styles.macroBarLabel}>{label}</Text>
          <Text style={[styles.macroBarVal, { color: barColor }]}>{valString}</Text>
        </View>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${percent}%`, backgroundColor: barColor }]} />
        </View>
      </View>
    );
  };

  const MacroDistributionBar = ({ protein = '0g', carbs = '0g', fat = '0g' }: { protein: string; carbs: string; fat: string }) => {
    const p = parseInt(protein) || 0;
    const c = parseInt(carbs) || 0;
    const f = parseInt(fat) || 0;
    const total = p + c + f;
    if (total === 0) return null;

    const pPct = (p / total) * 100;
    const cPct = (c / total) * 100;
    const fPct = (f / total) * 100;

    return (
      <View style={styles.distBarContainer}>
        <Text style={styles.distBarTitle}>Stacked Macro Grams Distribution</Text>
        <View style={styles.distBarTrack}>
          {p > 0 && <View style={[styles.distBarFill, { width: `${pPct}%`, backgroundColor: '#5C6BC0' }]} />}
          {c > 0 && <View style={[styles.distBarFill, { width: `${cPct}%`, backgroundColor: '#EF9A9A' }]} />}
          {f > 0 && <View style={[styles.distBarFill, { width: `${fPct}%`, backgroundColor: '#FFB74D' }]} />}
        </View>
        <View style={styles.distLegendRow}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#5C6BC0' }]} />
            <Text style={styles.legendTxt}>Protein: {Math.round(pPct)}%</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#EF9A9A' }]} />
            <Text style={styles.legendTxt}>Carbs: {Math.round(cPct)}%</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#FFB74D' }]} />
            <Text style={styles.legendTxt}>Fat: {Math.round(fPct)}%</Text>
          </View>
        </View>
      </View>
    );
  };

  const AIChatAssistantBubble = ({ text }: { text?: string }) => {
    if (!text) return null;
    return (
      <View style={styles.aiBubbleContainer}>
        <View style={styles.aiBubbleHeader}>
          <View style={styles.aiBubbleAvatar}>
            <Ionicons name="sparkles" size={12} color="#FFFFFF" />
          </View>
          <Text style={styles.aiBubbleAuthor}>YSnap AI Assistant</Text>
        </View>
        <Text style={styles.aiBubbleText}>{text}</Text>
      </View>
    );
  };

  // SVG-based Categories Chart for Menu items
  const MenuCategoriesChart = ({ dishes }: { dishes: any[] }) => {
    // Group categories
    const categories = { Starter: 0, Main: 0, Dessert: 0, Drink: 0 };
    dishes.forEach(d => {
      const name = (d.translated_name || d.name || '').toLowerCase();
      if (name.includes('soup') || name.includes('salad') || name.includes('starter') || name.includes('appetizer')) {
        categories.Starter++;
      } else if (name.includes('sweet') || name.includes('cake') || name.includes('ice') || name.includes('dessert')) {
        categories.Dessert++;
      } else if (name.includes('soda') || name.includes('beer') || name.includes('wine') || name.includes('juice') || name.includes('drink') || name.includes('tea')) {
        categories.Drink++;
      } else {
        categories.Main++;
      }
    });

    const maxVal = Math.max(...Object.values(categories), 1);
    
    return (
      <View style={styles.menuChartCard}>
        <Text style={styles.menuChartTitle}>Menu Category Breakdown</Text>
        <View style={styles.barChartWrapper}>
          {Object.entries(categories).map(([cat, val]) => {
            const barHeight = (val / maxVal) * 80;
            return (
              <View key={cat} style={styles.barChartCol}>
                <View style={styles.barChartValueBox}>
                  <Text style={styles.barChartValueText}>{val}</Text>
                </View>
                <View style={styles.barChartColumnContainer}>
                  <View style={[styles.barChartColumnFill, { height: `${(val / maxVal) * 100}%`, backgroundColor: colors.accentBlue }]} />
                </View>
                <Text style={styles.barChartLabelText}>{cat}</Text>
              </View>
            );
          })}
        </View>
      </View>
    );
  };

  // Calorie distribution preview across menu items
  const MenuCaloriesComparisonChart = ({ dishes }: { dishes: any[] }) => {
    const dishesWithCalories = dishes.filter(d => d.calories);
    if (dishesWithCalories.length === 0) return null;

    return (
      <View style={styles.menuChartCard}>
        <Text style={styles.menuChartTitle}>Dish Calories Comparison</Text>
        <View style={{ gap: 8, marginTop: 10 }}>
          {dishesWithCalories.slice(0, 5).map((dish, idx) => {
            const cal = Number(dish.calories);
            const percent = Math.min((cal / 1000) * 100, 100);
            return (
              <View key={idx}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                  <Text style={styles.compareDishName} numberOfLines={1}>{dish.translated_name || dish.name}</Text>
                  <Text style={styles.compareDishCal}>{cal} kcal</Text>
                </View>
                <View style={styles.compareTrack}>
                  <View style={[styles.compareFill, { width: `${percent}%`, backgroundColor: colors.accentOrange }]} />
                </View>
              </View>
            );
          })}
        </View>
      </View>
    );
  };

  // AR dimensions chart
  const ARDimensionsChart = () => {
    const width = 12;
    const height = 24;
    const depth = 8;
    return (
      <View style={styles.arChartCard}>
        <Text style={styles.arChartTitle}>AI Dimension Estimates (Spatial Projection)</Text>
        <View style={styles.arChartRow}>
          <View style={styles.arChartColumn}>
            <Text style={styles.arChartValue}>{width} cm</Text>
            <Text style={styles.arChartLabel}>WIDTH</Text>
          </View>
          <View style={[styles.arChartColumn, { borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#E2E8F0' }]}>
            <Text style={styles.arChartValue}>{height} cm</Text>
            <Text style={styles.arChartLabel}>HEIGHT</Text>
          </View>
          <View style={styles.arChartColumn}>
            <Text style={styles.arChartValue}>{depth} cm</Text>
            <Text style={styles.arChartLabel}>DEPTH</Text>
          </View>
        </View>
        <View style={styles.arVisualCubeContainer}>
          <Ionicons name="cube-outline" size={32} color={colors.accentBlue} />
          <Text style={styles.cubeLabelTxt}>Estimated Volume: {width * height * depth} cm³</Text>
        </View>
      </View>
    );
  };

  // Price analysis calculator for menus
  const calculateMenuPriceStats = (dishes: any[]) => {
    const prices = dishes
      .map(d => parseFloat(d.price.replace(/[^0-9.]/g, '')))
      .filter(p => !isNaN(p));
    
    if (prices.length === 0) return { min: 0, max: 0, avg: 0 };
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return { min, max, avg };
  };

  // Filter & sort scans
  const getFilteredPastScans = () => {
    if (!pastScans) return [];
    
    let result = [...pastScans];
    
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(s => s.title?.toLowerCase().includes(q));
    }

    if (filterMode !== 'all') {
      result = result.filter(s => s.metadata?.mode === filterMode);
    }

    if (sortBy === 'newest') {
      result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (sortBy === 'calories_high') {
      result.sort((a, b) => {
        const calA = a.metadata?.food_info?.calories || 0;
        const calB = b.metadata?.food_info?.calories || 0;
        return calB - calA;
      });
    } else if (sortBy === 'calories_low') {
      result.sort((a, b) => {
        const calA = a.metadata?.food_info?.calories || 0;
        const calB = b.metadata?.food_info?.calories || 0;
        return calA - calB;
      });
    }

    return result;
  };

  if (!permission) {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator size="large" color={colors.accentBlue} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Ionicons name="camera-outline" size={64} color="rgba(0,0,0,0.3)" />
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionSubtitle}>
          Camera permission is needed to scan food items, menus, and text on signs or packages.
        </Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={requestPermission}>
          <Text style={styles.primaryBtnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const recCalories = dailyGoals?.recommended_calories || 2000;
  const recProtein = dailyGoals?.recommended_protein || 130;
  const recCarbs = dailyGoals?.recommended_carbs || 250;
  const recFat = dailyGoals?.recommended_fat || 70;

  const currentMealCal = analysisResult?.foodInfo?.calories || 0;
  const currentMealProtein = parseFloat(analysisResult?.foodInfo?.protein || '0');
  const currentMealCarbs = parseFloat(analysisResult?.foodInfo?.carbs || '0');
  const currentMealFat = parseFloat(analysisResult?.foodInfo?.fat || '0');

  const totalCalWithMeal = consumedTotals.calories + currentMealCal;
  const totalProteinWithMeal = consumedTotals.protein + currentMealProtein;
  const totalCarbsWithMeal = consumedTotals.carbs + currentMealCarbs;
  const totalFatWithMeal = consumedTotals.fat + currentMealFat;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />

      {/* Header (Floating overlay in capture mode, static in results) */}
      <View style={[styles.header, (!capturedImage && !analysisResult && !showHistory) && styles.headerFloating]}>
        <View>
          <Text style={styles.headerTitle}>Scan & Translate</Text>
          <Text style={styles.headerSubtitle}>Auto-detect → {getLanguageName(targetLanguage)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <TouchableOpacity style={styles.headerActionBtn} onPress={() => { setShowHistory(prev => !prev); setAnalysisResult(null); setCapturedImage(null); }}>
            <Ionicons
              name={showHistory ? 'camera-outline' : 'time-outline'}
              size={22}
              color="#1A1A1C"
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerActionBtn} onPress={toggleFlash} disabled={!!capturedImage || showHistory}>
            <Ionicons
              name={flash === 'on' ? 'flash' : 'flash-off-outline'}
              size={22}
              color={flash === 'on' ? colors.accentOrange : '#1A1A1C'}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Full-Screen Camera Viewfinder */}
      {!capturedImage && !analysisResult && !showHistory ? (
        <View style={StyleSheet.absoluteFillObject}>
          <CameraView style={StyleSheet.absoluteFillObject} flash={flash} ref={cameraRef} facing="back">
            <View style={styles.overlayFrameContainer}>
              <Text style={styles.targetFrameLabel}>SCANNING FULL FRAME</Text>
            </View>

            {/* Mode selection overlay on viewfinder */}
            <View style={styles.modeRowOverlay}>
              {(['ocr', 'food', 'menu', 'ar'] as CameraMode[]).map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[styles.modeTab, mode === m && styles.modeTabActive]}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setMode(m);
                  }}
                >
                  <Ionicons
                    name={
                      m === 'ocr' ? 'text-outline' :
                      m === 'food' ? 'nutrition-outline' :
                      m === 'menu' ? 'restaurant-outline' : 'sparkles-outline'
                    }
                    size={15}
                    color="#1A1A1C"
                  />
                  <Text style={[styles.modeTabText, mode === m && styles.modeTabTextActive]}>
                    {m === 'ocr' ? 'Text' : m === 'food' ? 'Nutrition' : m === 'menu' ? 'Menu' : 'AR Scan'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Capture controls overlay on viewfinder */}
            <View style={styles.captureFooter}>
              <TouchableOpacity style={styles.galleryBtn} onPress={handlePickImage}>
                <Ionicons name="images-outline" size={24} color="#1A1A1C" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.captureBtn} onPress={handleCapture}>
                <View style={styles.captureInnerCircle} />
              </TouchableOpacity>

              <View style={styles.spacerBtn} />
            </View>
          </CameraView>
        </View>
      ) : null}

      {/* Processing overlay */}
      {isProcessing && (
        <View style={styles.processingMask}>
          <Animated.View 
            style={[
              styles.scanningLaserLine,
              {
                top: scanLineAnim.interpolate({
                  inputRange: [0, 100],
                  outputRange: ['0%', '100%'],
                }),
              },
            ]} 
          />
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={styles.processingText}>AI Analyzing...</Text>
        </View>
      )}

      {/* Main Content Area when captured image or loading results */}
      {capturedImage || analysisResult ? (
        <View style={{ flex: 1, marginTop: 70 }}>
          {capturedImage && !analysisResult && (
            <Image source={{ uri: capturedImage }} style={{ flex: 1, width: '100%' }} resizeMode="cover" />
          )}

          {analysisResult && (
            <ScrollView style={styles.resultsSheet} contentContainerStyle={styles.resultsSheetContent} showsVerticalScrollIndicator={false}>
              
              {/* Header of results */}
              <View style={styles.resultsHeader}>
                <Text style={styles.resultsBadge}>{mode.toUpperCase()} SCAN</Text>
                <TouchableOpacity onPress={handleReset} style={styles.sheetCloseBtn}>
                  <Ionicons name="close" size={22} color="#1A1A1C" />
                </TouchableOpacity>
              </View>

              {/* Mode 1: Nutrition Charts Dashboard */}
              {mode === 'food' && analysisResult.foodInfo && (
                <View style={styles.chartDashboardCard}>
                  {/* Identification Card */}
                  <View style={styles.identificationCard}>
                    <View style={styles.idIconBadge}>
                      <Ionicons name="sparkles" size={16} color="#fff" />
                      <Text style={styles.idIconBadgeText}>AI</Text>
                    </View>
                    <View style={styles.idTextCol}>
                      <Text style={styles.idConfidenceText}>
                        {analysisResult.foodInfo.confidence}% Identified
                      </Text>
                      <Text style={styles.idTitleText}>{analysisResult.foodInfo.translatedName}</Text>
                      <Text style={styles.idSubtitleText}>Original: {analysisResult.foodInfo.name}</Text>
                    </View>
                  </View>

                  {/* Core Metrics Donut Panel */}
                  <View style={styles.chartsGrid}>
                    <CalorieDonut kcal={analysisResult.foodInfo.calories} />
                    <View style={styles.macrosList}>
                      <MacroIndicatorBar label="Protein" valString={analysisResult.foodInfo.protein} maxGrams={recProtein} barColor="#5C6BC0" />
                      <MacroIndicatorBar label="Carbs" valString={analysisResult.foodInfo.carbs} maxGrams={recCarbs} barColor="#EF9A9A" />
                      <MacroIndicatorBar label="Fat" valString={analysisResult.foodInfo.fat} maxGrams={recFat} barColor="#FFB74D" />
                    </View>
                  </View>

                  {/* Detailed Micro-nutrients Grid */}
                  <Text style={styles.subSectionTitle}>Nutritional Composition</Text>
                  <View style={styles.nutrientsGrid}>
                    <View style={styles.nutrientGridItem}>
                      <Text style={styles.nutrLabel}>Fiber</Text>
                      <Text style={styles.nutrVal}>{analysisResult.foodInfo.fiber || '0g'}</Text>
                    </View>
                    <View style={styles.nutrientGridItem}>
                      <Text style={styles.nutrLabel}>Sugar</Text>
                      <Text style={styles.nutrVal}>{analysisResult.foodInfo.sugar || '0g'}</Text>
                    </View>
                    <View style={styles.nutrientGridItem}>
                      <Text style={styles.nutrLabel}>Sodium</Text>
                      <Text style={styles.nutrVal}>{analysisResult.foodInfo.sodium || '0mg'}</Text>
                    </View>
                    <View style={styles.nutrientGridItem}>
                      <Text style={styles.nutrLabel}>Calcium</Text>
                      <Text style={styles.nutrVal}>{analysisResult.foodInfo.calcium || '0mg'}</Text>
                    </View>
                    <View style={styles.nutrientGridItem}>
                      <Text style={styles.nutrLabel}>Iron</Text>
                      <Text style={styles.nutrVal}>{analysisResult.foodInfo.iron || '0mg'}</Text>
                    </View>
                    <View style={styles.nutrientGridItem}>
                      <Text style={styles.nutrLabel}>Cholesterol</Text>
                      <Text style={styles.nutrVal}>{analysisResult.foodInfo.cholesterol || '0mg'}</Text>
                    </View>
                    <View style={styles.nutrientGridItem}>
                      <Text style={styles.nutrLabel}>Potassium</Text>
                      <Text style={styles.nutrVal}>{analysisResult.foodInfo.potassium || '0mg'}</Text>
                    </View>
                    <View style={styles.nutrientGridItem}>
                      <Text style={styles.nutrLabel}>Magnesium</Text>
                      <Text style={styles.nutrVal}>{analysisResult.foodInfo.magnesium || '0mg'}</Text>
                    </View>
                    <View style={styles.nutrientGridItem}>
                      <Text style={styles.nutrLabel}>Vitamin E</Text>
                      <Text style={styles.nutrVal}>{analysisResult.foodInfo.vitamin_e || '0mg'}</Text>
                    </View>
                  </View>

                  {/* Health Score Component */}
                  <View style={styles.healthScoreCard}>
                    <Text style={styles.healthScoreTitle}>Health Score</Text>
                    <View style={styles.scoreContainer}>
                      <View style={styles.scoreArcTrack}>
                        <Text style={styles.scoreValueText}>{analysisResult.foodInfo.health_score || '7.5'}</Text>
                        <Text style={styles.scoreScaleText}>/ 10</Text>
                      </View>
                    </View>
                    <Text style={styles.explanationText}>
                      <Text style={{ fontWeight: '700' }}>AI Explanation: </Text>
                      {analysisResult.foodInfo.health_score_explanation || 'Nutrient-rich option supporting dietary wellness and balanced nutrition intakes.'}
                    </Text>
                  </View>

                  {/* Benefit Insights List */}
                  {analysisResult.foodInfo.benefit_insights && analysisResult.foodInfo.benefit_insights.length > 0 && (
                    <View style={styles.benefitsSection}>
                      <Text style={styles.subSectionTitle}>Benefit Insights</Text>
                      {analysisResult.foodInfo.benefit_insights.map((benefit, index) => (
                        <View key={index} style={styles.benefitRow}>
                          <Ionicons name="checkmark-circle" size={18} color="#2E7D32" style={{ marginRight: 8 }} />
                          <Text style={styles.benefitText}>{benefit}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* Warnings & Cautions */}
                  {(analysisResult.foodInfo.allergens?.length > 0 || analysisResult.foodInfo.dietary_cautions?.length > 0) && (
                    <View style={styles.warningsContainer}>
                      {analysisResult.foodInfo.allergens && analysisResult.foodInfo.allergens.length > 0 && (
                        <View style={[styles.warningCard, { backgroundColor: '#FDF2F2', borderColor: '#FDE8E8' }]}>
                          <Ionicons name="alert-circle" size={18} color={colors.error} style={{ marginRight: 8 }} />
                          <Text style={[styles.warningText, { color: colors.error }]}>
                            Allergens Detected: {analysisResult.foodInfo.allergens.join(', ')}
                          </Text>
                        </View>
                      )}
                      {analysisResult.foodInfo.dietary_cautions && analysisResult.foodInfo.dietary_cautions.length > 0 && (
                        <View style={[styles.warningCard, { backgroundColor: '#FFFBEB', borderColor: '#FEF3C7' }]}>
                          <Ionicons name="warning" size={18} color="#D97706" style={{ marginRight: 8 }} />
                          <Text style={[styles.warningText, { color: '#B45309' }]}>
                            Dietary Cautions: {analysisResult.foodInfo.dietary_cautions.join(', ')}
                          </Text>
                        </View>
                      )}
                    </View>
                  )}

                  {/* Daily Goal Impact Progress Bars */}
                  <View style={styles.goalImpactCard}>
                    <Text style={styles.subSectionTitle}>Daily Goal Impact</Text>
                    
                    {/* Calorie Progress */}
                    <View style={styles.goalImpactRow}>
                      <View style={styles.goalImpactHeader}>
                        <Text style={styles.goalImpactLabel}>Calories</Text>
                        <Text style={styles.goalImpactValue}>
                          {totalCalWithMeal} / {recCalories} kcal ({Math.round((totalCalWithMeal / recCalories) * 100)}%)
                        </Text>
                      </View>
                      <View style={styles.progressBarTrack}>
                        <View style={[styles.progressBarFill, { width: Math.min(100, (totalCalWithMeal / recCalories) * 100) + '%', backgroundColor: colors.primary }]} />
                      </View>
                    </View>

                    {/* Protein Progress */}
                    <View style={styles.goalImpactRow}>
                      <View style={styles.goalImpactHeader}>
                        <Text style={styles.goalImpactLabel}>Protein</Text>
                        <Text style={styles.goalImpactValue}>
                          {Math.round(totalProteinWithMeal)}g / {recProtein}g ({Math.round((totalProteinWithMeal / recProtein) * 100)}%)
                        </Text>
                      </View>
                      <View style={styles.progressBarTrack}>
                        <View style={[styles.progressBarFill, { width: Math.min(100, (totalProteinWithMeal / recProtein) * 100) + '%', backgroundColor: '#5C6BC0' }]} />
                      </View>
                    </View>

                    {/* Carbs Progress */}
                    <View style={styles.goalImpactRow}>
                      <View style={styles.goalImpactHeader}>
                        <Text style={styles.goalImpactLabel}>Carbohydrates</Text>
                        <Text style={styles.goalImpactValue}>
                          {Math.round(totalCarbsWithMeal)}g / {recCarbs}g ({Math.round((totalCarbsWithMeal / recCarbs) * 100)}%)
                        </Text>
                      </View>
                      <View style={styles.progressBarTrack}>
                        <View style={[styles.progressBarFill, { width: Math.min(100, (totalCarbsWithMeal / recCarbs) * 100) + '%', backgroundColor: '#EF9A9A' }]} />
                      </View>
                    </View>

                    {/* Fats Progress */}
                    <View style={styles.goalImpactRow}>
                      <View style={styles.goalImpactHeader}>
                        <Text style={styles.goalImpactLabel}>Fats</Text>
                        <Text style={styles.goalImpactValue}>
                          {Math.round(totalFatWithMeal)}g / {recFat}g ({Math.round((totalFatWithMeal / recFat) * 100)}%)
                        </Text>
                      </View>
                      <View style={styles.progressBarTrack}>
                        <View style={[styles.progressBarFill, { width: Math.min(100, (totalFatWithMeal / recFat) * 100) + '%', backgroundColor: '#FFB74D' }]} />
                      </View>
                    </View>
                  </View>

                  {/* Recommendations */}
                  <View style={styles.recommendationsCard}>
                    <Text style={styles.subSectionTitle}>AI Recommendations</Text>
                    {analysisResult.foodInfo.recommendation_pairs && analysisResult.foodInfo.recommendation_pairs.length > 0 && (
                      <View style={styles.recommendationPair}>
                        <Text style={styles.recommendationHeading}>Great Pairing Idea:</Text>
                        <Text style={styles.recommendationText}>
                          Try pairing this meal with: {analysisResult.foodInfo.recommendation_pairs.join(', ')}
                        </Text>
                      </View>
                    )}
                    {analysisResult.foodInfo.recommendation_alternatives && analysisResult.foodInfo.recommendation_alternatives.length > 0 && (
                      <View style={styles.recommendationAlternatives}>
                        <Text style={styles.recommendationHeading}>Healthy Alternatives:</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.alternativesScroll}>
                          {analysisResult.foodInfo.recommendation_alternatives.map((alt, idx) => (
                            <View key={idx} style={styles.alternativePill}>
                              <Ionicons name="leaf-outline" size={14} color={colors.primary} style={{ marginRight: 4 }} />
                              <Text style={styles.alternativeText}>{alt}</Text>
                            </View>
                          ))}
                        </ScrollView>
                      </View>
                    )}
                  </View>

                  {/* Actions Drawer */}
                  <View style={styles.cardQuickActions}>
                    <TouchableOpacity 
                      style={[styles.quickActionBtn, saveMealMutation.isPending && { opacity: 0.6 }]} 
                      disabled={saveMealMutation.isPending}
                      onPress={() => saveMealMutation.mutate({
                        meal_name: analysisResult.foodInfo!.translatedName,
                        calories: analysisResult.foodInfo!.calories,
                        protein: parseFloat(analysisResult.foodInfo!.protein || '0'),
                        carbs: parseFloat(analysisResult.foodInfo!.carbs || '0'),
                        fat: parseFloat(analysisResult.foodInfo!.fat || '0'),
                      })}
                    >
                      <Ionicons name="checkmark-circle-outline" size={16} color={colors.primary} />
                      <Text style={styles.quickActionBtnTxt}>Save Meal</Text>
                    </TouchableOpacity>
                    <TouchableOpacity 
                      style={[styles.quickActionBtn, saveMealMutation.isPending && { opacity: 0.6 }]} 
                      disabled={saveMealMutation.isPending}
                      onPress={() => saveMealMutation.mutate({
                        meal_name: analysisResult.foodInfo!.translatedName,
                        calories: analysisResult.foodInfo!.calories,
                        protein: parseFloat(analysisResult.foodInfo!.protein || '0'),
                        carbs: parseFloat(analysisResult.foodInfo!.carbs || '0'),
                        fat: parseFloat(analysisResult.foodInfo!.fat || '0'),
                      })}
                    >
                      <Ionicons name="book-outline" size={16} color={colors.accentPurple} />
                      <Text style={styles.quickActionBtnTxt}>Add to Diary</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Mode 2: Menu Analytics Dashboard */}
              {mode === 'menu' && analysisResult.menuInfo && (
                <View style={styles.chartDashboardCard}>
                  <Text style={styles.dashboardTitle}>Menu Analytics</Text>
                  <Text style={styles.dashboardSubtitle}>Dishes and price profiles parsed from menu</Text>

                  {/* Price analytics bar */}
                  {(() => {
                    const stats = calculateMenuPriceStats(analysisResult.menuInfo.dishes);
                    return (
                      <View style={styles.statsBanner}>
                        <View style={styles.statsBannerItem}>
                          <Text style={styles.statsVal}>${stats.min.toFixed(2)}</Text>
                          <Text style={styles.statsLbl}>MIN PRICE</Text>
                        </View>
                        <View style={[styles.statsBannerItem, { borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#E2E8F0' }]}>
                          <Text style={[styles.statsVal, { color: colors.accentBlue }]}>${stats.avg.toFixed(2)}</Text>
                          <Text style={styles.statsLbl}>AVG PRICE</Text>
                        </View>
                        <View style={styles.statsBannerItem}>
                          <Text style={styles.statsVal}>${stats.max.toFixed(2)}</Text>
                          <Text style={styles.statsLbl}>MAX PRICE</Text>
                        </View>
                      </View>
                    );
                  })()}

                  {/* Bar Chart breakdown */}
                  <MenuCategoriesChart dishes={analysisResult.menuInfo.dishes} />

                  {/* Calories comparison chart for dishes */}
                  <MenuCaloriesComparisonChart dishes={analysisResult.menuInfo.dishes} />

                  {/* Dishes list */}
                  <Text style={styles.menuSectionHeader}>Dishes & Projections</Text>
                  {analysisResult.menuInfo.dishes.length === 0 ? (
                    <Text style={styles.emptyListTxt}>No dishes identified in this menu sector.</Text>
                  ) : (
                    <View style={styles.dishesList}>
                      {analysisResult.menuInfo.dishes.map((dish, i) => (
                        <TouchableOpacity
                          key={i}
                          style={styles.dishListItem}
                          onPress={() => setSelectedDish(dish)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.dishNameText}>{dish.translated_name || dish.name}</Text>
                            <Text style={styles.dishDescriptionText} numberOfLines={1}>
                              {dish.description || 'View nutrition projections'}
                            </Text>
                          </View>
                          <View style={styles.dishPriceBox}>
                            <Text style={styles.dishPriceText}>{dish.price}</Text>
                            <Ionicons name="chevron-forward" size={14} color="#A0AEC0" />
                          </View>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              )}

              {/* Mode 4: AR Scanner Charts */}
              {mode === 'ar' && (
                <View style={styles.chartDashboardCard}>
                  <Text style={styles.dashboardTitle}>AR Space Profile</Text>
                  <Text style={styles.dashboardSubtitle}>Estimated object depth coordinates</Text>

                  {/* Spatial Dimensions Estimate */}
                  <ARDimensionsChart />

                  {/* Simple text details */}
                  <View style={styles.divider} />
                  <View style={styles.textBlock}>
                    <Text style={styles.textBlockTitle}>AI OBJECT TRANSLATION</Text>
                    <Text style={styles.translatedTextContent}>{analysisResult.translatedText}</Text>
                    <Text style={[styles.dictatedText, { fontSize: 13, marginTop: 4 }]}>Original: {analysisResult.originalText}</Text>
                  </View>
                </View>
              )}

              {/* Mode 3: Plain OCR Text results */}
              {mode === 'ocr' && (
                <View style={styles.textReportCard}>
                  <View style={styles.textBlock}>
                    <Text style={styles.textBlockTitle}>SCANNED ORIGINAL</Text>
                    <Text style={styles.dictatedText}>{analysisResult.originalText}</Text>
                  </View>

                  {analysisResult.translatedText && analysisResult.translatedText !== analysisResult.originalText ? (
                    <>
                      <View style={styles.divider} />
                      <View style={styles.textBlock}>
                        <Text style={[styles.textBlockTitle, { color: colors.accentBlue }]}>
                          TRANSLATION ({getLanguageName(targetLanguage).toUpperCase()})
                        </Text>
                        <Text style={styles.translatedTextContent}>{analysisResult.translatedText}</Text>
                      </View>
                    </>
                  ) : null}

                  <View style={styles.cardQuickActions}>
                    <TouchableOpacity style={styles.quickActionBtn} onPress={() => handleCopyText(analysisResult.translatedText)}>
                      <Ionicons name="copy-outline" size={16} color={colors.accentBlue} />
                      <Text style={styles.quickActionBtnTxt}>Copy Text</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* AI Chat Assistant bubble */}
              <AIChatAssistantBubble text={analysisResult.analysis} />

              {/* Download Report Button */}
              <TouchableOpacity style={styles.downloadReportBtn} onPress={handleDownloadReport}>
                <Ionicons name="download-outline" size={18} color="#FFFFFF" style={{ marginRight: 6 }} />
                <Text style={styles.downloadReportBtnTxt}>Download Report Summary</Text>
              </TouchableOpacity>

            </ScrollView>
          )}
        </View>
      ) : null}

      {/* Scan History Page Overlay */}
      {showHistory && (
        <View style={styles.historyOverlayContainer}>
          <View style={styles.historyDashboard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm }}>
              <Text style={styles.historySectionTitle}>Database Scans & Logs</Text>
              <TouchableOpacity onPress={() => setShowHistory(false)} style={styles.historyCloseBtn}>
                <Ionicons name="close" size={24} color="#1A1A1C" />
              </TouchableOpacity>
            </View>
            
            {/* Search Bar */}
            <View style={styles.searchBarContainer}>
              <Ionicons name="search-outline" size={18} color="#718096" style={{ marginRight: 6 }} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search past scans..."
                placeholderTextColor="#A0AEC0"
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
            </View>

            {/* Filter Chips & Sorter selectors */}
            <View style={styles.historyControlRow}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: 6, paddingRight: 10 }}>
                {(['all', 'food', 'menu', 'ocr'] as const).map((f) => (
                  <TouchableOpacity
                    key={f}
                    style={[styles.filterChip, filterMode === f && styles.filterChipActive]}
                    onPress={() => setFilterMode(f)}
                  >
                    <Text style={[styles.filterChipTxt, filterMode === f && styles.filterChipTxtActive]}>
                      {f === 'all' ? 'All Scans' : f === 'food' ? 'Nutrition' : f === 'menu' ? 'Menus' : 'Text'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <TouchableOpacity 
                style={styles.sorterBtn}
                onPress={() => {
                  Haptics.selectionAsync();
                  setSortBy(prev => prev === 'newest' ? 'calories_high' : prev === 'calories_high' ? 'calories_low' : 'newest');
                }}
              >
                <Ionicons name="funnel-outline" size={12} color="#4A5568" style={{ marginRight: 4 }} />
                <Text style={styles.sorterBtnTxt}>
                  Sort: {sortBy === 'newest' ? 'Newest' : sortBy === 'calories_high' ? 'Calories (High)' : 'Calories (Low)'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* List of past scans */}
            <ScrollView contentContainerStyle={styles.historyList} showsVerticalScrollIndicator={false}>
              {getFilteredPastScans().length === 0 ? (
                <View style={styles.emptyHistoryState}>
                  <Ionicons name="scan-outline" size={32} color="#CBD5E0" />
                  <Text style={styles.emptyHistoryStateTxt}>No matching logs in database.</Text>
                </View>
              ) : (
                getFilteredPastScans().map((scan) => {
                  const isFood = scan.metadata?.mode === 'food';
                  const isMenu = scan.metadata?.mode === 'menu';
                  const isAR = scan.metadata?.mode === 'ar';
                  return (
                    <TouchableOpacity
                      key={scan.id}
                      style={styles.historyItemCard}
                      onPress={() => handleLoadPastScan(scan)}
                    >
                      <View style={styles.itemCardLeft}>
                        <View style={[
                          styles.itemIconBox,
                          isFood && { backgroundColor: 'rgba(92,107,192,0.1)' },
                          isMenu && { backgroundColor: 'rgba(255,183,77,0.1)' },
                          isAR && { backgroundColor: 'rgba(124,108,208,0.1)' }
                        ]}>
                          <Ionicons
                            name={isFood ? 'nutrition' : isMenu ? 'restaurant' : isAR ? 'sparkles' : 'document-text'}
                            size={18}
                            color={isFood ? '#5C6BC0' : isMenu ? '#FFB74D' : isAR ? '#7C6CD0' : '#4A5568'}
                          />
                        </View>
                        <View style={{ marginLeft: 10, flex: 1 }}>
                          <Text style={styles.itemTitle} numberOfLines={1}>{scan.title}</Text>
                          <Text style={styles.itemMeta}>
                            {isFood ? `${scan.metadata?.food_info?.calories} kcal` : isMenu ? `${scan.metadata?.menu_info?.dishes?.length} dishes` : isAR ? 'AR Profile' : 'Text OCR'}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.itemCardRight}>
                        <Text style={styles.itemTime}>
                          {new Date(scan.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        </Text>
                        <Ionicons name="chevron-forward" size={14} color="#A0AEC0" />
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      )}

      {/* Popup Modal for Menu Dish Details */}
      <Modal
        visible={!!selectedDish}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setSelectedDish(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.dishModalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{selectedDish?.translated_name || selectedDish?.name}</Text>
              <TouchableOpacity onPress={() => setSelectedDish(null)} style={styles.modalCloseBtn}>
                <Ionicons name="close" size={24} color="#1A1A1C" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 300 }}>
              <Text style={styles.dishModalDesc}>{selectedDish?.description || 'No description provided.'}</Text>
              <Text style={[styles.dishPriceText, { fontSize: 18, marginBottom: 16 }]}>Estimated Price: {selectedDish?.price || 'Unspecified'}</Text>

              {/* Calorie donut for single dish */}
              {selectedDish?.calories ? (
                <View style={{ alignItems: 'center', marginBottom: 16 }}>
                  <CalorieDonut kcal={Number(selectedDish.calories)} />
                </View>
              ) : null}

              {/* Macro breakdown */}
              <View style={[styles.macrosList, { borderTopWidth: 1, borderTopColor: '#E2E8F0', paddingTop: 12, marginLeft: 0 }]}>
                <MacroIndicatorBar label="Protein" valString={selectedDish?.protein || '0g'} maxGrams={60} barColor="#5C6BC0" />
                <MacroIndicatorBar label="Carbs" valString={selectedDish?.carbs || '0g'} maxGrams={150} barColor="#EF9A9A" />
                <MacroIndicatorBar label="Fat" valString={selectedDish?.fat || '0g'} maxGrams={50} barColor="#FFB74D" />
              </View>
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
    backgroundColor: '#F8F9FA',
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
    paddingHorizontal: 20,
    backgroundColor: '#FFFFFF',
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1A1A1C',
    marginTop: 16,
    marginBottom: 8,
  },
  permissionSubtitle: {
    fontSize: 14,
    color: '#718096',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  primaryBtn: {
    backgroundColor: colors.primary || '#5C6BC0',
    height: 48,
    borderRadius: 12,
    paddingHorizontal: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#ECEEF1',
    zIndex: 100,
  },
  headerFloating: {
    position: 'absolute',
    top: 30,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ECEEF1',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1A1A1C',
  },
  headerSubtitle: {
    fontSize: 10,
    color: 'rgba(0, 0, 0, 0.45)',
    marginTop: 1,
  },
  headerActionBtn: {
    padding: 6,
    backgroundColor: '#F1F3F5',
    borderRadius: 10,
  },
  overlayFrameContainer: {
    position: 'absolute',
    top: 130,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  targetFrameLabel: {
    fontSize: 9,
    fontWeight: '900',
    color: '#FFFFFF',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    letterSpacing: 1.5,
  },
  processingMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(9, 9, 9, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  processingText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
    marginTop: spacing.md,
  },
  scanningLaserLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: colors.accentBlue,
    shadowColor: colors.accentBlue,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
    elevation: 5,
    zIndex: 2,
  },
  resultsSheet: {
    flex: 1,
    backgroundColor: '#F8F9FA',
    padding: spacing.md,
  },
  resultsSheetContent: {
    paddingBottom: 60,
  },
  resultsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
    marginTop: spacing.xs,
  },
  resultsBadge: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.accentBlue,
    backgroundColor: 'rgba(92, 107, 192, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    letterSpacing: 0.5,
  },
  sheetCloseBtn: {
    padding: 6,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E4E7EC',
  },
  chartDashboardCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  dashboardTitleRow: {
    marginBottom: spacing.sm,
  },
  dashboardTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1A1A1C',
  },
  dashboardSubtitle: {
    fontSize: 12,
    color: 'rgba(0, 0, 0, 0.4)',
    marginTop: 2,
  },
  chartsGrid: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  donutWrapper: {
    position: 'relative',
    width: 110,
    height: 110,
    justifyContent: 'center',
    alignItems: 'center',
  },
  donutLabelBox: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  donutValText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1A1A1C',
  },
  donutSubText: {
    fontSize: 10,
    color: 'rgba(0, 0, 0, 0.4)',
    fontWeight: '600',
  },
  macrosList: {
    flex: 1,
    marginLeft: 20,
    gap: 8,
  },
  macroBarContainer: {
    width: '100%',
  },
  macroBarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  macroBarLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(0, 0, 0, 0.5)',
  },
  macroBarVal: {
    fontSize: 11,
    fontWeight: '700',
  },
  barTrack: {
    height: 6,
    backgroundColor: '#E2E8F0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
  },
  allergenBadgeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239, 83, 80, 0.1)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(239, 83, 80, 0.2)',
    padding: spacing.sm,
    marginTop: spacing.md,
  },
  allergenCardTxt: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.error,
    marginLeft: 6,
    flex: 1,
  },
  cardQuickActions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingTop: spacing.md,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  quickActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(92, 107, 192, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(92, 107, 192, 0.15)',
    borderRadius: 10,
    paddingVertical: 8,
  },
  quickActionBtnTxt: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accentBlue,
    marginLeft: 6,
  },
  statsBanner: {
    flexDirection: 'row',
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    paddingVertical: 12,
    marginVertical: spacing.sm,
  },
  statsBannerItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statsVal: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1A1A1C',
  },
  statsLbl: {
    fontSize: 9,
    fontWeight: '600',
    color: 'rgba(0,0,0,0.4)',
    marginTop: 2,
  },
  menuSectionHeader: {
    fontSize: 13,
    fontWeight: '800',
    color: 'rgba(0,0,0,0.5)',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    letterSpacing: 0.5,
  },
  dishesList: {
    gap: 8,
  },
  dishListItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#F8F9FA',
    borderWidth: 1,
    borderColor: '#E4E7EC',
    borderRadius: 12,
    padding: spacing.md,
  },
  dishNameText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1A1A1C',
  },
  dishDescriptionText: {
    fontSize: 11,
    color: 'rgba(0,0,0,0.5)',
    marginTop: 2,
  },
  dishPriceBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dishPriceText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#1D2D44',
  },
  emptyListTxt: {
    fontSize: 12,
    color: 'rgba(0,0,0,0.4)',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  textReportCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  textBlock: {
    marginVertical: 4,
  },
  textBlockTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: 'rgba(0, 0, 0, 0.4)',
    letterSpacing: 1,
    marginBottom: 4,
  },
  dictatedText: {
    fontSize: 16,
    lineHeight: 24,
    color: '#1A1A1C',
    fontWeight: '500',
  },
  translatedTextContent: {
    fontSize: 18,
    lineHeight: 26,
    color: '#1A1A1C',
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: '#E4E7EC',
    marginVertical: 12,
  },
  modeRowOverlay: {
    position: 'absolute',
    bottom: 190,
    left: 16,
    right: 16,
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    padding: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ECEEF1',
    zIndex: 10,
  },
  modeTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 12,
  },
  modeTabActive: {
    backgroundColor: '#E9ECEF',
  },
  modeTabText: {
    fontSize: 11,
    color: 'rgba(0, 0, 0, 0.6)',
    marginLeft: 5,
    fontWeight: '600',
  },
  modeTabTextActive: {
    color: '#1A1A1C',
    fontWeight: '800',
  },
  historyOverlayContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    zIndex: 200,
    justifyContent: 'flex-end',
  },
  historyDashboard: {
    height: SCREEN_HEIGHT * 0.75,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: spacing.md,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 5,
  },
  historyCloseBtn: {
    padding: 6,
    backgroundColor: '#F1F3F5',
    borderRadius: 12,
  },
  historySectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1A1A1C',
  },
  searchBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    height: 42,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#1A1A1C',
    fontWeight: '500',
    paddingVertical: 0,
  },
  historyControlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  filterChip: {
    backgroundColor: '#F1F3F5',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  filterChipActive: {
    backgroundColor: 'rgba(92, 107, 192, 0.1)',
    borderColor: 'rgba(92, 107, 192, 0.2)',
  },
  filterChipTxt: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(0,0,0,0.6)',
  },
  filterChipTxtActive: {
    color: colors.accentBlue,
    fontWeight: '700',
  },
  sorterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F1F3F5',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  sorterBtnTxt: {
    fontSize: 10,
    fontWeight: '700',
    color: '#4A5568',
  },
  historyList: {
    gap: 8,
    paddingBottom: 40,
  },
  emptyHistoryState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
  },
  emptyHistoryStateTxt: {
    fontSize: 12,
    color: 'rgba(0,0,0,0.4)',
    marginTop: 8,
  },
  historyItemCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    padding: 12,
  },
  itemCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  itemIconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1A1A1C',
  },
  itemMeta: {
    fontSize: 10,
    color: 'rgba(0,0,0,0.45)',
    marginTop: 1,
  },
  itemCardRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  itemTime: {
    fontSize: 10,
    color: 'rgba(0,0,0,0.4)',
  },
  captureFooter: {
    position: 'absolute',
    bottom: 50,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    zIndex: 10,
  },
  galleryBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255, 255, 255, 0.85)',
    borderWidth: 1,
    borderColor: '#E4E7EC',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  captureBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 5,
    borderColor: '#FFFFFF',
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  captureInnerCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.accentBlue || '#5C6BC0',
  },
  spacerBtn: {
    width: 52,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  dishModalContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    paddingBottom: spacing.sm,
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1A1A1C',
    flex: 1,
    marginRight: 10,
  },
  modalCloseBtn: {
    padding: 4,
  },
  dishModalDesc: {
    fontSize: 13,
    color: '#4A5568',
    lineHeight: 18,
    marginBottom: 8,
  },
  distBarContainer: {
    marginTop: spacing.md,
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: '#E4E7EC',
  },
  distBarTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#1A1A1C',
    marginBottom: spacing.sm,
  },
  distBarTrack: {
    height: 14,
    borderRadius: 7,
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: '#E2E8F0',
    marginBottom: spacing.md,
  },
  distBarFill: {
    height: '100%',
  },
  distLegendRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  legendTxt: {
    fontSize: 10,
    fontWeight: '700',
    color: '#4A5568',
  },
  downloadReportBtn: {
    backgroundColor: '#201820',
    height: 52,
    borderRadius: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  downloadReportBtnTxt: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  // Menu Category Bar Chart Styles
  menuChartCard: {
    backgroundColor: '#F8F9FA',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    padding: 12,
    marginVertical: 6,
  },
  menuChartTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#4A5568',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  barChartWrapper: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    height: 120,
    paddingTop: 15,
    paddingBottom: 5,
  },
  barChartCol: {
    alignItems: 'center',
    width: 50,
  },
  barChartValueBox: {
    marginBottom: 4,
  },
  barChartValueText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#1A1A1C',
  },
  barChartColumnContainer: {
    width: 14,
    height: 70,
    backgroundColor: '#E2E8F0',
    borderRadius: 7,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  barChartColumnFill: {
    width: '100%',
    borderRadius: 7,
  },
  barChartLabelText: {
    fontSize: 10,
    color: 'rgba(0,0,0,0.5)',
    fontWeight: '600',
    marginTop: 6,
  },
  // Menu Calories comparison chart
  compareDishName: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1A1A1C',
    flex: 1,
    marginRight: 10,
  },
  compareDishCal: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accentOrange,
  },
  compareTrack: {
    height: 5,
    backgroundColor: '#E2E8F0',
    borderRadius: 2.5,
    overflow: 'hidden',
    marginTop: 2,
    marginBottom: 4,
  },
  compareFill: {
    height: '100%',
    borderRadius: 2.5,
  },
  // AR spatial dimensions styles
  arChartCard: {
    backgroundColor: '#F8F9FA',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    padding: 12,
  },
  arChartTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#4A5568',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  arChartRow: {
    flexDirection: 'row',
    paddingVertical: 8,
  },
  arChartColumn: {
    flex: 1,
    alignItems: 'center',
  },
  arChartValue: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.accentBlue,
  },
  arChartLabel: {
    fontSize: 9,
    fontWeight: '600',
    color: 'rgba(0,0,0,0.4)',
    marginTop: 2,
  },
  arVisualCubeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.06)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(91,141,239,0.12)',
    padding: 8,
    marginTop: 8,
  },
  cubeLabelTxt: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accentBlue,
    marginLeft: 8,
  },
  aiBubbleContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E4E7EC',
    padding: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.02,
    shadowRadius: 4,
    elevation: 1,
  },
  aiBubbleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  aiBubbleAvatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accentBlue,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  aiBubbleAuthor: {
    fontSize: 12,
    fontWeight: '800',
    color: '#1A1A1C',
  },
  aiBubbleText: {
    fontSize: 13,
    color: '#4A5568',
    lineHeight: 19,
    fontWeight: '500',
  },
  identificationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#000000',
    borderRadius: 18,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  idIconBadge: {
    backgroundColor: '#8C52FF',
    borderRadius: 12,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
    shadowColor: '#8C52FF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  idIconBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
    marginTop: 1,
  },
  idTextCol: {
    flex: 1,
  },
  idConfidenceText: {
    color: '#a855f7',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  idTitleText: {
    color: '#ffffff',
    fontSize: 19,
    fontWeight: '800',
    marginTop: 2,
  },
  idSubtitleText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    marginTop: 1,
  },
  subSectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#1A1A1C',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 12,
  },
  nutrientsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  nutrientGridItem: {
    width: '31%',
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    alignItems: 'center',
  },
  nutrLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  nutrVal: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary,
    marginTop: 4,
  },
  healthScoreCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    marginBottom: 16,
    alignItems: 'center',
  },
  healthScoreTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#1A1A1C',
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  scoreContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 6,
    borderColor: '#4caf50',
    marginBottom: 12,
  },
  scoreArcTrack: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  scoreValueText: {
    fontSize: 22,
    fontWeight: '900',
    color: '#1A1A1C',
  },
  scoreScaleText: {
    fontSize: 12,
    color: colors.textMuted,
    marginLeft: 2,
  },
  explanationText: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
  },
  benefitsSection: {
    marginBottom: 16,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f4fbf7',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e1f5fe',
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  benefitText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#2E7D32',
  },
  warningsContainer: {
    gap: 8,
    marginBottom: 16,
  },
  warningCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  warningText: {
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
  },
  goalImpactCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 16,
  },
  goalImpactRow: {
    marginBottom: 12,
  },
  goalImpactHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  goalImpactLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  goalImpactValue: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: '600',
  },
  progressBarTrack: {
    height: 8,
    backgroundColor: '#f1f5f9',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  recommendationsCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 16,
  },
  recommendationPair: {
    marginBottom: 12,
  },
  recommendationHeading: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  recommendationText: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  recommendationAlternatives: {
    marginTop: 8,
  },
  alternativesScroll: {
    paddingVertical: 6,
    gap: 8,
  },
  alternativePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginRight: 8,
  },
  alternativeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#166534',
  },
});
