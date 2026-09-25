import {
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Smartphone,
  Trash2,
} from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMuseThread } from "./threads";
import { colors } from "./ui";
import { useWorkspace } from "./workspace";

export function ChatSidebar({ onClose }: { onClose?: () => void }) {
  const { selection, mainId, select, start, sideChats, removeThread } = useMuseThread();
  const { workspace, navigate } = useWorkspace();
  const [search, setSearch] = useState("");

  const threadItems = (sideChats || [])
    .filter((t) => t.id !== mainId)
    .filter((t) => !search.trim() || t.name.toLowerCase().includes(search.toLowerCase()));

  const isMainActive = selection.id === mainId;

  return (
    <View
      style={{
        width: 250,
        backgroundColor: "#F9FAFB",
        borderRightWidth: 1,
        borderRightColor: "#E5E7EB",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Search Header */}
      <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: "#FFFFFF",
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#E5E7EB",
            paddingHorizontal: 8,
            height: 34,
            gap: 6,
          }}
        >
          <Search size={14} color="#9CA3AF" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search"
            placeholderTextColor="#9CA3AF"
            style={
              {
                flex: 1,
                fontSize: 13,
                color: colors.text,
                paddingVertical: 2,
                outlineStyle: "none",
              } as any
            }
          />
          <Pressable style={{ padding: 2 }}>
            <MoreHorizontal size={14} color="#9CA3AF" />
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 16 }}
      >
        {/* Main Chat Item */}
        <Pressable
          onPress={() => {
            select({ id: mainId, existing: true });
            onClose?.();
          }}
          style={({ pressed, hovered }: any) => ({
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 10,
            paddingVertical: 8,
            borderRadius: 8,
            backgroundColor: isMainActive ? "#EEF2F6" : hovered ? "#F3F4F6" : "transparent",
            gap: 8,
            marginBottom: 12,
          })}
        >
          <MessageSquare size={16} color={isMainActive ? colors.blueDark : colors.text} />
          <Text
            style={{
              fontSize: 13,
              fontWeight: isMainActive ? "700" : "500",
              color: isMainActive ? colors.blueDark : colors.text,
              flex: 1,
            }}
          >
            Main chat
          </Text>
        </Pressable>

        {/* Channels Section */}
        <View style={{ marginBottom: 16 }}>
          <Text
            style={{
              fontSize: 11,
              fontWeight: "600",
              color: "#9CA3AF",
              paddingHorizontal: 10,
              marginBottom: 4,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Channels
          </Text>
          <Pressable
            onPress={() => {
              navigate("connectors");
              onClose?.();
            }}
            style={({ hovered }: any) => ({
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 10,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: hovered ? "#F3F4F6" : "transparent",
              gap: 8,
            })}
          >
            <Smartphone size={15} color="#25D366" />
            <Text style={{ fontSize: 13, color: colors.text, flex: 1 }}>WhatsApp</Text>
            {workspace.connections?.some(
              (conn) => conn.id === "whatsapp" || (conn as any).kind === "whatsapp",
            ) && (
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: "#25D366",
                }}
              />
            )}
          </Pressable>
        </View>

        {/* Side chats Section */}
        <View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 10,
              marginBottom: 6,
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: "600",
                color: "#9CA3AF",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Side chats
            </Text>
            {/* New Side Chat Button */}
            <Pressable
              onPress={() => {
                start();
                onClose?.();
              }}
              {...({ title: "New side chat" } as any)}
              style={({ pressed, hovered }: any) => ({
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: 5,
                backgroundColor: hovered ? "#E5E7EB" : "#EEF2F6",
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
              })}
            >
              <Plus size={13} color="#2563EB" strokeWidth={2.5} />
              <Text style={{ fontSize: 11, fontWeight: "700", color: "#2563EB" }}>New</Text>
            </Pressable>
          </View>

          {threadItems.length === 0 ? (
            <Pressable
              onPress={() => {
                start();
                onClose?.();
              }}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 10,
                borderRadius: 8,
                backgroundColor: "#F3F4F6",
                marginTop: 4,
                borderWidth: 1,
                borderColor: "#E5E7EB",
                borderStyle: "dashed",
              }}
            >
              <Text
                style={{
                  fontSize: 12,
                  color: colors.blueDark,
                  fontWeight: "600",
                  textAlign: "center",
                }}
              >
                + Start a new side chat
              </Text>
            </Pressable>
          ) : (
            threadItems.map((thread) => {
              const active = selection.id === thread.id;
              return (
                <View
                  key={thread.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    borderRadius: 8,
                    backgroundColor: active ? "#EEF2F6" : "transparent",
                    marginBottom: 2,
                    paddingRight: 6,
                  }}
                >
                  <Pressable
                    onPress={() => {
                      select({ id: thread.id, existing: true });
                      onClose?.();
                    }}
                    style={{
                      flex: 1,
                      flexDirection: "row",
                      alignItems: "center",
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      gap: 8,
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        fontSize: 13,
                        color: active ? colors.blueDark : colors.text,
                        fontWeight: active ? "600" : "400",
                        flex: 1,
                      }}
                    >
                      {thread.name || "Untitled side chat"}
                    </Text>
                    {active && (
                      <View
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          backgroundColor: colors.blueDark,
                        }}
                      />
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      const name = thread.name || "this side chat";
                      if (typeof window !== "undefined" && typeof window.confirm === "function") {
                        const ok = window.confirm(`Delete "${name}"? This cannot be undone.`);
                        if (ok) {
                          removeThread(thread.id);
                          onClose?.();
                        }
                      } else {
                        Alert.alert("Delete chat?", `Delete "${name}"? This cannot be undone.`, [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Delete",
                            style: "destructive",
                            onPress: () => {
                              removeThread(thread.id);
                              onClose?.();
                            },
                          },
                        ]);
                      }
                    }}
                    {...({ title: "Delete side chat" } as any)}
                    style={{ padding: 4 }}
                  >
                    <Trash2 size={13} color="#9CA3AF" />
                  </Pressable>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}
