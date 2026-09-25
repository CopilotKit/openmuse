import {
  CalendarDays,
  ChevronRight,
  FileText,
  Globe2,
  Lightbulb,
  LogOut,
  type LucideIcon,
  Mail,
  MessageCircle,
  MessagesSquare,
  Monitor,
  PanelsTopLeft,
  Plug,
  Settings,
  Shapes,
  SquareCheck,
  X,
} from "lucide-react-native";
import { useEffect } from "react";
import { Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { Section } from "../../../packages/domain/src";
import { closeNav, createEscapeHandler, useNavOpen } from "./nav/nav-state";
import { colors, IconButton, s } from "./ui";
import { useWorkspace } from "./workspace";

type Destination =
  | {
      kind: "section";
      id: Exclude<Section, "today" | "connections">;
      label: string;
      detail: string;
      icon: LucideIcon;
    }
  | { kind: "computer"; label: string; detail: string; icon: LucideIcon }
  | { kind: "threads"; label: string; detail: string; icon: LucideIcon };

const groups: { heading: string; items: Destination[] }[] = [
  {
    heading: "Main",
    items: [
      {
        kind: "section",
        id: "chat",
        label: "Chat",
        detail: "Talk to your agent",
        icon: MessageCircle,
      },
      {
        kind: "section",
        id: "browser",
        label: "Browser",
        detail: "Your connected browsing sessions",
        icon: Globe2,
      },
      {
        kind: "computer",
        label: "Computer",
        detail: "Your agent's computer",
        icon: Monitor,
      },
      {
        kind: "section",
        id: "connectors",
        label: "Connectors",
        detail: "Integrations and connected services",
        icon: Plug,
      },
    ],
  },
  {
    heading: "Plan",
    items: [
      {
        kind: "section",
        id: "activity",
        label: "Activity",
        detail: "Plans, progress, decisions and results",
        icon: PanelsTopLeft,
      },
      {
        kind: "section",
        id: "ideas",
        label: "Ideas",
        detail: "Useful next steps, grounded in your world",
        icon: Lightbulb,
      },
      {
        kind: "section",
        id: "goals",
        label: "Goals",
        detail: "Longer-term goals and things to watch",
        icon: SquareCheck,
      },
    ],
  },
  {
    heading: "Workspace",
    items: [
      {
        kind: "section",
        id: "apps",
        label: "Apps",
        detail: "Connections, capabilities and memory",
        icon: Shapes,
      },
      {
        kind: "section",
        id: "mail",
        label: "Mail",
        detail: "The conversations behind your work",
        icon: Mail,
      },
      {
        kind: "section",
        id: "calendar",
        label: "Calendar",
        detail: "Time for what matters",
        icon: CalendarDays,
      },
      {
        kind: "section",
        id: "files",
        label: "Files",
        detail: "Documents, forms and filled copies",
        icon: FileText,
      },
    ],
  },
  {
    heading: "More",
    items: [
      {
        kind: "section",
        id: "settings",
        label: "Settings",
        detail: "Email, models, agent and integrations in one place",
        icon: Settings,
      },
      {
        kind: "threads",
        label: "Conversations",
        detail: "Switch between your chat threads",
        icon: MessagesSquare,
      },
    ],
  },
];

export function NavDrawer({ onOpenThreads }: { onOpenThreads: () => void }) {
  const { section, navigate, open: openDetail, sessionUser, logout } = useWorkspace();
  const { width } = useWindowDimensions();
  // Single source of truth for drawer visibility — the shared nav controller.
  const open = useNavOpen();

  // Escape closes the drawer on web.
  useEffect(() => {
    if (!open || Platform.OS !== "web") return;
    const handler = createEscapeHandler(closeNav);
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  if (!open) return null;

  const select = (item: Destination) => {
    closeNav();
    if (item.kind === "section") navigate(item.id);
    else if (item.kind === "computer") openDetail({ type: "computer" });
    else onOpenThreads();
  };
  const isActive = (item: Destination) => item.kind === "section" && section === item.id;

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 60,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close navigation menu"
        onPress={closeNav}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(19, 38, 49, 0.35)",
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: Math.min(330, width * 0.86),
          backgroundColor: "#FFF",
          borderTopRightRadius: 26,
          borderBottomRightRadius: 26,
          shadowColor: "#132631",
          shadowOffset: { width: 6, height: 0 },
          shadowOpacity: 0.14,
          shadowRadius: 28,
          elevation: 10,
        }}
      >
        <View style={[s.between, { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 10 }]}>
          <Text style={[s.title, { fontSize: 19 }]}>Menu</Text>
          <IconButton icon={X} label="Close menu" onPress={closeNav} />
        </View>
        <ScrollView
          // Web shows the native scrollbar; native keeps its thin auto-hiding indicator.
          showsVerticalScrollIndicator={Platform.OS === "web"}
          persistentScrollbar={false}
          contentContainerStyle={{
            paddingHorizontal: 12,
            paddingTop: 6,
            paddingBottom: 30,
          }}
        >
          {groups.map((group) => (
            <View key={group.heading} style={{ marginBottom: 20 }}>
              <Text
                style={[
                  s.label,
                  {
                    fontSize: 10,
                    letterSpacing: 1.2,
                    color: colors.muted,
                    marginLeft: 14,
                    marginBottom: 7,
                  },
                ]}
              >
                {group.heading.toUpperCase()}
              </Text>
              {group.items.map((item) => {
                const active = isActive(item);
                return (
                  <Pressable
                    key={item.label}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: active }}
                    onPress={() => select(item)}
                    style={({ pressed }) => [
                      s.row,
                      {
                        gap: 14,
                        paddingHorizontal: 12,
                        paddingVertical: 11,
                        borderRadius: 15,
                        backgroundColor: active
                          ? colors.sky
                          : pressed
                            ? colors.canvas
                            : "transparent",
                      },
                    ]}
                  >
                    <View
                      style={[
                        s.iconBox,
                        {
                          width: 39,
                          height: 39,
                          borderRadius: 13,
                          backgroundColor: active ? "#FFF" : colors.canvas,
                        },
                      ]}
                    >
                      <item.icon size={19} color={active ? colors.blueDark : colors.text} />
                    </View>
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={[s.text, { fontSize: 14, fontWeight: active ? "600" : "500" }]}>
                        {item.label}
                      </Text>
                      <Text style={[s.small, { fontSize: 11 }]}>{item.detail}</Text>
                    </View>
                    <ChevronRight size={15} color={colors.muted} />
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
        {sessionUser && (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.line,
              paddingHorizontal: 16,
              paddingVertical: 14,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              backgroundColor: "#FFF",
              borderBottomRightRadius: 26,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: colors.sky,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "700", color: colors.blueDark }}>
                  {sessionUser.username.slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View style={{ gap: 2 }}>
                <Text style={[s.text, { fontSize: 13, fontWeight: "600" }]}>
                  @{sessionUser.username}
                </Text>
                <Text style={[s.muted, { fontSize: 11, textTransform: "capitalize" }]}>
                  {sessionUser.role}
                </Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log out"
              onPress={() => {
                closeNav();
                void logout();
              }}
              style={({ pressed }) => [
                s.row,
                {
                  gap: 6,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 10,
                  backgroundColor: pressed ? "rgba(239, 68, 68, 0.15)" : "rgba(239, 68, 68, 0.08)",
                },
              ]}
            >
              <LogOut size={15} color="#ef4444" />
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#ef4444" }}>Log out</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}
