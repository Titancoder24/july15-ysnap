import React from 'react';
import {
  StyleSheet,
  View,
  Pressable,
  Platform,
  useWindowDimensions,
  Image,
  ImageStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { colors } from '../../constants/colors';
import { useAuth } from '../../contexts/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { AppIcon } from '../ui/AppIcon';

interface FloatingTabBarProps {
  state: any;
  descriptors: any;
  navigation: any;
}

export const FloatingTabBar: React.FC<FloatingTabBarProps> = ({
  state,
  descriptors,
  navigation,
}) => {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user } = useAuth();

  // Load avatar image if available
  const { data: profile } = useQuery<any>({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase.from('profiles').select('avatar_path').eq('id', user.id).single();
      return data;
    },
    enabled: !!user?.id,
  });

  const routes = state.routes;

  const triggerHaptic = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const getIcon = (routeName: string, isFocused: boolean) => {
    const iconColor = isFocused ? '#FFFFFF' : '#9B9BA1';
    const iconSize = 22;

    switch (routeName) {
      case 'index':
        return <AppIcon name="home" size={iconSize} color={iconColor} focused={isFocused} />;
      case 'converse':
        return <AppIcon name="converse" size={iconSize} color={iconColor} focused={isFocused} />;
      case 'camera':
        return (
          <View style={[
            styles.cameraIconContainer,
            isFocused && styles.cameraIconContainerActive
          ]}>
            <AppIcon name="camera" size={26} color="#FFFFFF" focused={isFocused} />
          </View>
        );
      case 'practice':
        return <AppIcon name="practice" size={iconSize} color={iconColor} focused={isFocused} />;
      case 'profile':
        if (profile?.avatar_path) {
          return (
            <Image
              source={{ uri: profile.avatar_path }}
              style={[
                styles.avatar,
                isFocused && ({ borderColor: '#FFFFFF', borderWidth: 1.5 } as ImageStyle),
              ]}
            />
          );
        }
        return <AppIcon name="profile" size={iconSize} color={iconColor} focused={isFocused} />;
      default:
        return <AppIcon name="home" size={iconSize} color={iconColor} focused={isFocused} />;
    }
  };

  const containerWidth = Math.min(480, width - 32);
  const tabWidth = (containerWidth - 16) / 5; // 8px padding on each side is 16px total padding
  const translation = useSharedValue(8 + state.index * tabWidth);

  React.useEffect(() => {
    translation.value = withTiming(8 + state.index * tabWidth, { duration: 200 });
  }, [state.index, tabWidth]);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateX: translation.value }],
    };
  });

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.outerContainer,
        {
          bottom: insets.bottom + 12,
        },
      ]}
    >
      <View style={[styles.pillContainer, { width: containerWidth }]}>
        <Animated.View style={[styles.slidingIndicator, { width: tabWidth }, animatedStyle]} />
        {routes.map((route: any, index: number) => {
          const { options } = descriptors[route.key];
          const isFocused = state.index === index;

          const onPress = () => {
            triggerHaptic();
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });

            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate({ name: route.name, merge: true });
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: 'tabLongPress',
              target: route.key,
            });
          };

          const label = options.title || route.name;

          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={route.name === 'camera' ? 'Camera Translation' : options.tabBarAccessibilityLabel || `Navigate to ${label}`}
              testID={options.tabBarTestID}
              onPress={onPress}
              onLongPress={onLongPress}
              style={styles.tabButton}
            >
              <View style={styles.iconCapsule}>
                {getIcon(route.name, isFocused)}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  outerContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    zIndex: 100,
    ...Platform.select({
      web: {
        position: 'fixed' as any,
      },
    }),
  },
  pillContainer: {
    flexDirection: 'row',
    height: 72,
    backgroundColor: Platform.OS === 'web' ? 'rgba(17, 17, 17, 0.85)' : '#111111',
    borderRadius: 36,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'space-between',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1.5,
    position: 'relative',
    ...Platform.select({
      ios: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.4,
        shadowRadius: 12,
      },
      android: {
        elevation: 6,
      },
      web: {
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.4,
        shadowRadius: 12,
      },
    }),
  },
  tabButton: {
    flex: 1,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
  },
  iconCapsule: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  slidingIndicator: {
    position: 'absolute',
    height: 48,
    backgroundColor: '#2D2D2D',
    borderRadius: 24,
    top: 12,
    left: 0,
    zIndex: 1,
  },
  cameraIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#1E1E20',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#333336',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
    elevation: 4,
  },
  cameraIconContainerActive: {
    backgroundColor: '#2D2D30',
    borderColor: '#FFFFFF',
    transform: [{ scale: 1.05 }],
  },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#2D2D2D',
  },
});
export default FloatingTabBar;
