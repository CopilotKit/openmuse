import { ArrowUpRight, Check, ChevronRight, type LucideIcon, X } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MascotState } from "./mascot-state";
import { MuseCat } from "./muse-cat";
import { WEB_SCROLLBAR_CSS } from "./web-scrollbar-css";
export const colors = {
  canvas: "#F6F7F9",
  card: "#FFFFFF",
  text: "#11191C",
  muted: "#5B6165",
  line: "#E4E7EB",
  blue: "#B5DBFC",
  blueDark: "#1473C8",
  sky: "#EDF7FD",
  green: "#E3F3E8",
  lavender: "#F0EEFA",
  orange: "#FDF0DF",
  danger: "#AA4A45",
};
export const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  text: { color: colors.text, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  small: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  label: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  title: { color: colors.text, fontSize: 21, fontWeight: "600", letterSpacing: -0.6 },
  heading: { color: colors.text, fontSize: 16, fontWeight: "600", letterSpacing: -0.25 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
  },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 16 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
    backgroundColor: "#FFF",
    minHeight: 48,
  },
  field: { gap: 7, marginBottom: 14 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 17,
    minHeight: 42,
    paddingVertical: 10,
    borderRadius: 24,
  },
  primary: { backgroundColor: colors.blue },
  secondary: { backgroundColor: "#F1F2F3" },
  buttonText: { fontSize: 14, fontWeight: "600" },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    alignSelf: "flex-start",
    backgroundColor: colors.canvas,
  },
  chipText: { fontSize: 11, fontWeight: "600", color: colors.muted },
  iconBox: {
    width: 42,
    height: 42,
    borderRadius: 13,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.sky,
  },
  error: { padding: 16, borderRadius: 14, backgroundColor: "#FBEFED", marginVertical: 10, gap: 4 },
  modalShade: {
    flex: 1,
    backgroundColor: "rgba(35,48,44,0.25)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  sheet: {
    backgroundColor: colors.canvas,
    borderRadius: 26,
    width: "100%",
    maxWidth: 790,
    maxHeight: "94%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.line,
  },
});
/**
 * Shared wide content container.
 *
 * Every page/route (chat, Apps, settings, history, tools, computer, browser,
 * Connectors) renders inside the single shell column in App.tsx that carries
 * `testID={SHELL_TESTID}`. On web, ensureWebStyles() applies the one container
 * rule — desktop: width min(94vw, 1500px), centered — so route-level maxWidths
 * can't drift apart again. Do not add per-route maxWidths; fix the shared one.
 */
export const SHELL_TESTID = "openmuse-shell";

const WEB_LAYOUT_CSS = `
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:#B5DBFC}
${WEB_SCROLLBAR_CSS}
/* One shared wide container for every route. */
@media (min-width:900px){
  [data-testid="${SHELL_TESTID}"]{max-width:min(94vw,1500px);margin-inline:auto}
}
/* Desktop type rhythm: keep long-form text comfortable at wide widths. */
:focus-visible{outline:2px solid #1473C8;outline-offset:2px;border-radius:6px}
/* Muse Cat mascot animations & reactive dynamics */
.mcp-paw-l{transform-box:fill-box;transform-origin:center bottom;animation:mcp-leftType .34s cubic-bezier(.45,0,.55,1) infinite;will-change:transform}
.mcp-paw-r{transform-box:fill-box;transform-origin:center bottom;animation:mcp-rightType .34s cubic-bezier(.45,0,.55,1) infinite;will-change:transform}
@keyframes mcp-leftType{0%,100%{transform:translate(0px,-1px) rotate(-2deg)}25%{transform:translate(5px,8px) rotate(6deg)}50%{transform:translate(1px,-3px) rotate(0deg)}75%{transform:translate(-2px,3px) rotate(-3deg)}}
@keyframes mcp-rightType{0%,100%{transform:translate(0px,-3px) rotate(2deg)}25%{transform:translate(2px,3px) rotate(3deg)}50%{transform:translate(-5px,8px) rotate(-6deg)}75%{transform:translate(-1px,-1px) rotate(0deg)}}

.mcp-state-coding .mcp-paw-l,.mcp-state-coding .mcp-paw-r{animation-duration:.16s}
.mcp-state-writing .mcp-paw-l,.mcp-state-writing .mcp-paw-r{animation-duration:.22s}
.mcp-state-searching .mcp-paw-l,.mcp-state-searching .mcp-paw-r{animation-duration:.26s}
.mcp-state-listening .mcp-paw-l,.mcp-state-listening .mcp-paw-r{animation:none!important}
.mcp-state-dispatching .mcp-paw-l,.mcp-state-dispatching .mcp-paw-r{animation-duration:.18s}
.mcp-state-delegating .mcp-paw-l,.mcp-state-delegating .mcp-paw-r{animation-duration:.20s}
.mcp-state-restarting_browser .mcp-paw-l,.mcp-state-restarting_browser .mcp-paw-r{animation-duration:.16s}
.mcp-state-clearing_history .mcp-paw-l,.mcp-state-clearing_history .mcp-paw-r{animation-duration:.28s}
.mcp-state-awaiting_approval .mcp-paw-l,.mcp-state-awaiting_approval .mcp-paw-r{animation-duration:.60s}
.mcp-state-success .mcp-paw-l,.mcp-state-success .mcp-paw-r{animation:none!important}

.mcp-cat-all{transform-origin:244px 230px;transition:transform 0.45s cubic-bezier(0.34,1.4,0.64,1);animation:mcp-breathe 3.6s ease-in-out infinite}
.mcp-state-thinking .mcp-cat-all{transform:rotate(3.2deg) translateY(-3px);animation:mcp-ponderSway 4.2s ease-in-out infinite}
.mcp-state-coding .mcp-cat-all{animation:mcp-headBob .32s cubic-bezier(.45,0,.55,1) infinite alternate}
.mcp-state-writing .mcp-cat-all{animation:mcp-headBob .48s cubic-bezier(.45,0,.55,1) infinite alternate}
.mcp-state-listening .mcp-cat-all{transform:scale(1.025) translateY(-4px)}
.mcp-state-reading .mcp-cat-all,.mcp-state-pdf_review .mcp-cat-all{transform:translateY(2px) scale(0.995)}
.mcp-state-uploading .mcp-cat-all{transform:translateY(-2px)}
.mcp-state-error .mcp-cat-all{animation:mcp-errorWobble .22s ease-in-out infinite alternate}

@keyframes mcp-breathe{0%,100%{transform:translateY(0px) scale(1)}50%{transform:translateY(-2.5px) scale(1.006)}}
@keyframes mcp-ponderSway{0%,100%{transform:rotate(2.8deg) translateY(-2px)}50%{transform:rotate(4.2deg) translateY(-4px)}}
@keyframes mcp-headBob{0%{transform:translateY(0px) rotate(0.4deg)}100%{transform:translateY(-3px) rotate(-0.4deg)}}
@keyframes mcp-errorWobble{0%{transform:translateX(-2.5px) rotate(-0.8deg)}100%{transform:translateX(2.5px) rotate(0.8deg)}}

.mcp-ear-l{transform-origin:172px 100px;transition:transform 0.35s ease}
.mcp-ear-r{transform-origin:315px 100px;transition:transform 0.35s ease}
.mcp-state-thinking .mcp-ear-r{transform:rotate(10deg) scale(0.96)}
.mcp-state-thinking .mcp-ear-l{transform:rotate(-3deg)}
.mcp-state-listening .mcp-ear-l{transform:rotate(3deg) translateY(-2px)}
.mcp-state-listening .mcp-ear-r{transform:rotate(-3deg) translateY(-2px)}
.mcp-state-error .mcp-ear-l{transform:rotate(-12deg) translateY(4px)}
.mcp-state-error .mcp-ear-r{transform:rotate(12deg) translateY(4px)}

.mcp-top-paw-l,.mcp-top-paw-r{transform-box:fill-box;transform-origin:50% 50%;transition:transform 0.38s cubic-bezier(0.34,1.4,0.64,1)}
.mcp-state-thinking .mcp-top-paw-r{transform:translate(-65px,-20px) rotate(-28deg);animation:mcp-chinScratchR 1.25s ease-in-out infinite alternate}
.mcp-state-thinking .mcp-top-paw-l{transform:translate(2px,3px) rotate(3deg)}
@keyframes mcp-chinScratchR{0%{transform:translate(-63px,-18px) rotate(-25deg)}50%{transform:translate(-68px,-24px) rotate(-32deg)}100%{transform:translate(-64px,-19px) rotate(-27deg)}}

.mcp-state-coding .mcp-top-paw-l{animation:mcp-drumL 0.28s cubic-bezier(0.45,0,.55,1) infinite alternate}
.mcp-state-coding .mcp-top-paw-r{animation:mcp-drumR 0.28s cubic-bezier(0.45,0,.55,1) infinite alternate;animation-delay:0.14s}
.mcp-state-writing .mcp-top-paw-l{animation:mcp-drumL 0.45s ease-in-out infinite alternate}
.mcp-state-writing .mcp-top-paw-r{animation:mcp-drumR 0.45s ease-in-out infinite alternate;animation-delay:0.22s}
@keyframes mcp-drumL{0%{transform:translateY(0px) rotate(0deg)}100%{transform:translateY(-6px) rotate(-4deg)}}
@keyframes mcp-drumR{0%{transform:translateY(0px) rotate(0deg)}100%{transform:translateY(-6px) rotate(4deg)}}

.mcp-state-success .mcp-top-paw-l{transform:translate(-14px,-52px) rotate(-34deg);animation:mcp-cheerPawL 0.55s ease-in-out infinite alternate}
.mcp-state-success .mcp-top-paw-r{transform:translate(14px,-52px) rotate(34deg);animation:mcp-cheerPawR 0.55s ease-in-out infinite alternate}
@keyframes mcp-cheerPawL{0%{transform:translate(-14px,-50px) rotate(-32deg)}100%{transform:translate(-18px,-58px) rotate(-38deg)}}
@keyframes mcp-cheerPawR{0%{transform:translate(14px,-50px) rotate(32deg)}100%{transform:translate(18px,-58px) rotate(38deg)}}

.mcp-state-error .mcp-top-paw-l{transform:translate(34px,-34px) rotate(46deg)}
.mcp-state-error .mcp-top-paw-r{transform:translate(-34px,-34px) rotate(-46deg)}

.mcp-tears{opacity:0;pointer-events:none;transform:scale(0.65) translateY(-8px);transform-origin:244px 210px;transition:opacity 0.25s ease,transform 0.35s cubic-bezier(0.34,1.56,0.64,1)}
.mcp-state-error .mcp-tears{opacity:1;transform:scale(1) translateY(0)}
.mcp-tear-stream{animation:mcp-tearStreamGush 0.5s ease-in-out infinite alternate}
@keyframes mcp-tearStreamGush{0%{transform:scaleY(0.94) translateY(0px)}100%{transform:scaleY(1.06) translateY(2px)}}
.mcp-tear-drop{animation:mcp-tearFall 0.85s cubic-bezier(0.55,0,1,0.45) infinite}
.mcp-tear-drop-2{animation-delay:0.38s}
@keyframes mcp-tearFall{0%{transform:translateY(0px) scale(0.5);opacity:0}25%{opacity:1;transform:translateY(5px) scale(1)}80%{opacity:0.9;transform:translateY(22px) scale(1.1)}100%{opacity:0;transform:translateY(32px) scale(0.4)}}

.mcp-headphone-ring{transition:stroke 0.3s,opacity 0.3s}
.mcp-state-thinking .mcp-headphone-ring{stroke:#8b5cf6;animation:mcp-ringPulse 1.4s ease-in-out infinite alternate}
.mcp-state-coding .mcp-headphone-ring{stroke:#10b981;animation:mcp-ringPulse 0.35s ease-in-out infinite alternate}
.mcp-state-writing .mcp-headphone-ring{stroke:#6366f1;animation:mcp-ringPulse 0.6s ease-in-out infinite alternate}
.mcp-state-listening .mcp-headphone-ring{stroke:#3b82f6;animation:mcp-ringPulse 0.8s ease-in-out infinite alternate}
.mcp-state-searching .mcp-headphone-ring,.mcp-state-reading .mcp-headphone-ring,.mcp-state-pdf_review .mcp-headphone-ring{stroke:#0ea5e9;animation:mcp-ringPulse 0.7s ease-in-out infinite alternate}
.mcp-state-uploading .mcp-headphone-ring{stroke:#f59e0b;animation:mcp-ringPulse 0.5s ease-in-out infinite alternate}
.mcp-state-success .mcp-headphone-ring{stroke:#10b981}
.mcp-state-error .mcp-headphone-ring{stroke:#ef4444}
@keyframes mcp-ringPulse{0%{opacity:0.35;stroke-width:3}100%{opacity:1;stroke-width:6}}

.mcp-thought-cloud{opacity:0;pointer-events:none;transform-origin:325px 85px;transform:scale(0.6) translateY(10px);transition:opacity 0.3s,transform 0.4s cubic-bezier(0.34,1.5,0.64,1)}
.mcp-state-thinking .mcp-thought-cloud{opacity:1;transform:scale(1) translateY(0px)}

.mcp-happy-eyes{opacity:0;transition:opacity 0.2s ease}
.mcp-state-success .mcp-happy-eyes{opacity:1}
.mcp-state-success .mcp-normal-eyes{opacity:0}

.mcp-screen-cursor{animation:mcp-cursorBlink 0.75s steps(2,start) infinite}
@keyframes mcp-cursorBlink{0%,100%{opacity:1}50%{opacity:0}}

.mcp-glow{transform-origin:244px 320px;animation:mcp-glowShift 2.4s linear infinite}
@keyframes mcp-glowShift{0%{opacity:.15}50%{opacity:.35}100%{opacity:.15}}

.mcp-sparkles{opacity:0;transition:opacity .25s ease}
.mcp-state-success .mcp-sparkles{opacity:1}
.mcp-state-success .mcp-sp{transform-box:fill-box;transform-origin:center;animation:mcp-spark 1s ease-in-out infinite alternate}
.mcp-state-success .mcp-sp:nth-child(2){animation-delay:.2s}
.mcp-state-success .mcp-sp:nth-child(3){animation-delay:.35s}
@keyframes mcp-spark{from{transform:scale(.85) rotate(0deg);opacity:.45}to{transform:scale(1.18) rotate(18deg);opacity:1}}

@media (prefers-reduced-motion:reduce){.mcp-paw-l,.mcp-paw-r,.mcp-cat-all,.mcp-top-paw-l,.mcp-top-paw-r,.mcp-glow,.mcp-state-success .mcp-sp,.mcp-tears,.mcp-tear-stream,.mcp-tear-drop{animation:none!important}}
`;

let webStylesInjected = false;
/**
 * Injects the web-only layout stylesheet once. No-op on native (no DOM) and
 * safe to call repeatedly. Called from App's WorkspaceShell on web.
 */
export function ensureWebStyles() {
  if (webStylesInjected || typeof document === "undefined") return;
  webStylesInjected = true;
  const el = document.createElement("style");
  el.setAttribute("data-openmuse", "layout");
  el.textContent = WEB_LAYOUT_CSS;
  document.head.appendChild(el);
}
export function Button({
  children,
  onPress,
  icon: Icon,
  primary,
  disabled,
  busy,
  small,
  danger,
  style,
}: {
  children: ReactNode;
  onPress: () => void;
  icon?: LucideIcon;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  danger?: boolean;
  style?: ViewStyle;
}) {
  const color = danger ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary ? s.primary : s.secondary,
        small && { minHeight: 38, paddingVertical: 7, paddingHorizontal: 13 },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} size="small" />
      ) : Icon ? (
        <Icon size={15} color={color} />
      ) : null}
      <Text style={[s.buttonText, { color }]}>{children}</Text>
    </Pressable>
  );
}
export function IconButton({
  icon: Icon,
  label,
  onPress,
  danger,
  size = 40,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  danger?: boolean;
  size?: number;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <View style={{ position: "relative", alignItems: "center" }}>
      {hovered && (
        <View
          pointerEvents="none"
          style={
            {
              position: "absolute",
              bottom: size + 4,
              backgroundColor: "#1E293B",
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.18,
              shadowRadius: 4,
              elevation: 8,
              zIndex: 9999,
              whiteSpace: "nowrap",
            } as any
          }
        >
          <Text
            style={{
              color: "#FFFFFF",
              fontSize: 11,
              fontWeight: "600",
              letterSpacing: 0.2,
            }}
          >
            {label}
          </Text>
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        {...({ title: label } as any)}
        style={({ pressed }) => [
          {
            width: size,
            height: size,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: size / 2,
            backgroundColor: pressed ? colors.line : hovered ? "#F1F5F9" : "#FFFFFF",
          },
        ]}
      >
        <Icon
          size={Math.round(size * 0.48)}
          strokeWidth={1.8}
          color={danger ? colors.danger : colors.text}
        />
      </Pressable>
    </View>
  );
}
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}
export function Chip({ children, tint }: { children: ReactNode; tint?: string }) {
  return (
    <View style={[s.chip, tint ? { backgroundColor: tint } : null]}>
      <Text style={s.chipText}>{children}</Text>
    </View>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={s.field}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        accessibilityLabel={label}
        {...props}
        style={[
          s.input,
          props.multiline && { minHeight: 120, textAlignVertical: "top" },
          props.style,
        ]}
      />
    </View>
  );
}
export function Empty({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <View style={{ alignItems: "center", padding: 32, gap: 10 }}>
      <View style={[s.iconBox, { width: 48, height: 48, borderRadius: 16 }]}>
        <Icon size={22} color={colors.blueDark} />
      </View>
      <Text style={s.heading}>{title}</Text>
      <Text style={[s.muted, { textAlign: "center", maxWidth: 360 }]}>{detail}</Text>
      {children}
    </View>
  );
}
export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <View accessibilityRole="alert" style={s.error}>
      <Text style={[s.text, { color: colors.danger }]}>{error}</Text>
    </View>
  ) : null;
}
export function Sheet({
  title,
  subtitle,
  children,
  onClose,
  wide,
  customHeader,
  contentStyle,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  /**
   * Wide sheets share the main shell's desktop container rule (SHELL_TESTID):
   * min(94vw, 1500px), centered. Use for workspace-style detail views (computer,
   * browser console, task/file detail). Keep forms and confirms narrow.
   */
  wide?: boolean;
  customHeader?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = width < 600;
  // Same container math as the main shell: min(94vw, 1500px). Not applied on
  // compact/mobile widths, where the sheet stays a full-screen bottom sheet.
  const wideMaxWidth = Math.min(width * 0.94, 1500);
  return (
    <Modal transparent animationType={compact ? "slide" : "fade"} visible onRequestClose={onClose}>
      <View style={[s.modalShade, compact && { padding: 0, justifyContent: "flex-end" }]}>
        <View
          accessibilityViewIsModal
          style={[
            s.sheet,
            !compact && wide && { maxWidth: wideMaxWidth },
            compact && {
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              paddingBottom: Math.max(insets.bottom, 12),
              maxHeight: "94%",
            },
          ]}
        >
          {compact && (
            <View
              style={{
                alignSelf: "center",
                width: 34,
                height: 4,
                borderRadius: 3,
                backgroundColor: "#D8DBDE",
                marginTop: 10,
              }}
            />
          )}
          {customHeader ? (
            customHeader
          ) : (
            <View
              style={[
                s.between,
                {
                  padding: compact ? 12 : 16,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.line,
                },
              ]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                {title ? (
                  <Text style={[s.title, { fontSize: compact ? 18 : 20, marginVertical: 0 }]}>
                    {title}
                  </Text>
                ) : null}
                {subtitle && <Text style={[s.muted, { fontSize: 13 }]}>{subtitle}</Text>}
              </View>
              <IconButton icon={X} label="Close details" onPress={onClose} />
            </View>
          )}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            persistentScrollbar={false}
            contentContainerStyle={[{ padding: compact ? 14 : 18 }, contentStyle]}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
export function CheckRow({
  label,
  checked,
  onPress,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[s.row, { gap: 10, paddingVertical: 9 }]}
    >
      <View
        style={{
          width: 19,
          height: 19,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: checked ? colors.text : colors.line,
          backgroundColor: checked ? colors.text : "#FFF",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Check size={13} color="#FFF" />}
      </View>
      <Text style={[s.text, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}
export function SectionHeading({
  title,
  action,
  onPress,
}: {
  title: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={[s.between, { marginBottom: 14 }]}>
      <Text style={s.heading}>{title}</Text>
      {action && onPress && (
        <Pressable accessibilityRole="button" onPress={onPress} style={[s.row, { gap: 5 }]}>
          <Text style={[s.small, { color: colors.text }]}>{action}</Text>
          <ArrowUpRight size={13} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}
export function LinkRow({
  title,
  detail,
  onPress,
  icon: Icon,
  tint,
}: {
  title: string;
  detail?: string;
  onPress: () => void;
  icon: LucideIcon;
  tint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        s.row,
        { paddingVertical: 11, gap: 12, borderRadius: 10 },
        pressed && { backgroundColor: colors.canvas },
      ]}
    >
      <View style={[s.iconBox, { backgroundColor: tint || colors.sky }]}>
        <Icon size={19} color={colors.text} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.text, { fontWeight: "500" }]}>{title}</Text>
        {detail && <Text style={s.small}>{detail}</Text>}
      </View>
      <ChevronRight size={15} color={colors.muted} />
    </Pressable>
  );
}

/** The Muse Cat mascot (the user's own animated SVG), shared by every assistant surface. */
export function Mascot({
  size = 80,
  variant = "sky",
  state = "idle",
}: {
  size?: number;
  variant?: "sky" | "sand" | "lilac";
  state?: MascotState;
}) {
  const palette = {
    sky: "#ECF5FA",
    sand: "#FAF0DF",
    lilac: "#F1ECF9",
  }[variant];
  return (
    <View
      accessibilityLabel="Muse cat"
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <View
        style={{
          position: "absolute",
          width: size * 0.94,
          height: size * 0.94,
          borderRadius: size,
          backgroundColor: palette,
        }}
      />
      <MuseCat size={size} state={state} />
    </View>
  );
}
export function dateLabel(value: string, options?: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", options || { month: "short", day: "numeric" });
}
export function timeLabel(value: string, timeZone?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}
export function relativeDate(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  return diff < 60_000
    ? "Just now"
    : diff < 3600_000
      ? `${Math.floor(diff / 60_000)}m ago`
      : diff < 86400_000
        ? `${Math.floor(diff / 3600_000)}h ago`
        : dateLabel(value);
}

export function resultSummary(value: string) {
  return /^Saved to (?:sample|local) sent mail(?: · .+)?$/.test(value)
    ? "Reply saved in your local Sent mail."
    : value;
}
