import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

export const colors = {
  background: '#F6F7F9',
  surface: '#FFFFFF',
  text: '#14181F',
  muted: '#525B6B',
  border: '#D5DAE1',
  primary: '#1F4FD8',
  onPrimary: '#FFFFFF',
  danger: '#B3261E',
  dangerSurface: '#FCEEEC',
  warningSurface: '#FFF4D6',
  successSurface: '#E6F4EA',
};

/**
 * Layout rules that keep the screen usable at the largest system font and on a
 * small phone: nothing has a fixed height, text always wraps, every action is a
 * full-width button at least 48pt tall, and each screen scrolls.
 */
export function Title({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={styles.title}>
      {children}
    </Text>
  );
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[styles.body, muted && styles.muted]}>{children}</Text>;
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

/** Label above value, stacked, so long values and large fonts never collide. */
export function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.body}>{value}</Text>
    </View>
  );
}

type Tone = 'info' | 'warning' | 'error' | 'success';

export function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  const background = {
    info: colors.surface,
    warning: colors.warningSurface,
    error: colors.dangerSurface,
    success: colors.successSurface,
  }[tone];
  return (
    <View
      style={[styles.notice, { backgroundColor: background }]}
      accessibilityRole={tone === 'error' ? 'alert' : 'text'}
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.body}>{children}</Text>
    </View>
  );
}

export function Progress({ children }: { children: ReactNode }) {
  return (
    <View style={styles.progress} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.primary} />
      <Text style={[styles.body, styles.flex]}>{children}</Text>
    </View>
  );
}

export function ActionButton(props: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
}) {
  const kind = props.kind ?? 'primary';
  const disabled = props.disabled || props.busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && styles.buttonPrimary,
        kind === 'secondary' && styles.buttonSecondary,
        kind === 'danger' && styles.buttonDanger,
        (pressed || disabled) && styles.buttonDimmed,
      ]}
    >
      {props.busy && <ActivityIndicator color={kind === 'primary' ? colors.onPrimary : colors.text} />}
      <Text
        style={[
          styles.buttonText,
          kind === 'primary' && { color: colors.onPrimary },
          kind === 'danger' && { color: colors.danger },
        ]}
      >
        {props.title}
      </Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  body: { fontSize: 16, lineHeight: 22, color: colors.text },
  muted: { color: colors.muted },
  label: { fontSize: 13, color: colors.muted },
  field: { gap: 2 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  notice: {
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
  },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  button: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonSecondary: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  buttonDanger: { backgroundColor: colors.surface, borderColor: colors.danger, borderWidth: 1 },
  buttonDimmed: { opacity: 0.55 },
  buttonText: { fontSize: 16, fontWeight: '600', color: colors.text, textAlign: 'center', flexShrink: 1 },
});
