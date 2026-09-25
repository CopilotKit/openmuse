import { Plus, ShieldCheck, Trash2, UserRound } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, Card, colors, ErrorNotice, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

export interface PublicUser {
  username: string;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: string;
}

/** Admin-only user management: add users, reset passwords, roles, disable, remove. */
export function UsersScreen() {
  const { api, sessionUser, notify } = useWorkspace();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "user">("user");
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPass, setResetPass] = useState("");
  const [myCurrent, setMyCurrent] = useState("");
  const [myNew, setMyNew] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.request<{ users: PublicUser[] }>("/api/users");
      setUsers(res.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<void>, done?: string) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      if (done) notify(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const addUser = () =>
    run(async () => {
      await api.request("/api/users", {
        username: newName.trim(),
        password: newPass,
        role: newRole,
      });
      setNewName("");
      setNewPass("");
      setNewRole("user");
    }, `User added.`);

  const removeUser = (username: string) =>
    run(async () => {
      await api.request(`/api/users/${encodeURIComponent(username)}`, undefined, "DELETE");
    }, `User removed.`);

  const toggleRole = (u: PublicUser) =>
    run(async () => {
      await api.request(
        `/api/users/${encodeURIComponent(u.username)}`,
        { role: u.role === "admin" ? "user" : "admin" },
        "PATCH",
      );
    });

  const toggleDisabled = (u: PublicUser) =>
    run(async () => {
      await api.request(
        `/api/users/${encodeURIComponent(u.username)}`,
        { disabled: !u.disabled },
        "PATCH",
      );
    });

  const resetPassword = (username: string) =>
    run(async () => {
      await api.request(
        `/api/users/${encodeURIComponent(username)}`,
        { password: resetPass },
        "PATCH",
      );
      setResetFor(null);
      setResetPass("");
    }, `Password updated.`);

  const changeMyPassword = () =>
    run(async () => {
      await api.request(
        `/api/users/${encodeURIComponent(sessionUser.username)}`,
        { currentPassword: myCurrent, password: myNew },
        "PATCH",
      );
      setMyCurrent("");
      setMyNew("");
    }, "Your password was changed.");

  return (
    <View style={{ gap: 16 }}>
      <View>
        <Text style={s.title}>Users</Text>
        <Text style={[s.muted, { marginTop: 4 }]}>
          Signed in as {sessionUser.username} ({sessionUser.role}). Passwords are stored as one-way
          hashes — they can be reset, never read back.
        </Text>
      </View>
      {!!error && <ErrorNotice error={error} />}

      <Card>
        <Text style={[s.text, { fontWeight: "700", marginBottom: 8 }]}>Change my password</Text>
        <Field
          label="Current password"
          value={myCurrent}
          onChangeText={setMyCurrent}
          secureTextEntry
          placeholder="••••••••"
        />
        <Field
          label="New password (min 8 characters)"
          value={myNew}
          onChangeText={setMyNew}
          secureTextEntry
          placeholder="••••••••"
        />
        <Button primary disabled={busy || !myCurrent || !myNew} onPress={changeMyPassword}>
          Change password
        </Button>
      </Card>

      <Card>
        <Text style={[s.text, { fontWeight: "700", marginBottom: 8 }]}>Add user</Text>
        <Field
          label="Username"
          value={newName}
          onChangeText={setNewName}
          placeholder="e.g. simran"
          autoCapitalize="none"
        />
        <Field
          label="Password (min 8 characters)"
          value={newPass}
          onChangeText={setNewPass}
          secureTextEntry
          placeholder="••••••••"
        />
        <View style={[s.row, { gap: 8, marginBottom: 12 }]}>
          <Button small primary={newRole === "user"} onPress={() => setNewRole("user")}>
            User
          </Button>
          <Button small primary={newRole === "admin"} onPress={() => setNewRole("admin")}>
            Admin
          </Button>
        </View>
        <Text style={[s.small, { marginBottom: 12 }]}>
          Users get chat, mail, calendar and files. Admins also get settings, connectors and this
          screen.
        </Text>
        <Button
          primary
          disabled={busy || !newName.trim() || !newPass}
          onPress={addUser}
          icon={Plus}
        >
          Add user
        </Button>
      </Card>

      <View style={{ gap: 8 }}>
        <Text style={[s.small, { marginLeft: 12 }]}>Accounts</Text>
        {!users ? (
          <Text style={s.muted}>Loading…</Text>
        ) : (
          users.map((u) => (
            <Card key={u.username}>
              <View style={[s.row, { gap: 10, alignItems: "center" }]}>
                <View
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 17,
                    backgroundColor: u.role === "admin" ? "#E8F0FF" : "#F1F2F3",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {u.role === "admin" ? (
                    <ShieldCheck size={18} color="#3D7BFF" />
                  ) : (
                    <UserRound size={18} color={colors.muted} />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.text}>
                    {u.username}
                    {u.username === sessionUser.username ? " (you)" : ""}
                    {u.disabled ? " · disabled" : ""}
                  </Text>
                  <Text style={s.small}>{u.role}</Text>
                </View>
              </View>
              {resetFor === u.username ? (
                <View style={{ marginTop: 10, gap: 8 }}>
                  <Field
                    label="New password (min 8 characters)"
                    value={resetPass}
                    onChangeText={setResetPass}
                    secureTextEntry
                    placeholder="••••••••"
                  />
                  <View style={[s.row, { gap: 8 }]}>
                    <Button
                      small
                      primary
                      disabled={busy || resetPass.length < 8}
                      onPress={() => void resetPassword(u.username)}
                    >
                      Save
                    </Button>
                    <Button
                      small
                      onPress={() => {
                        setResetFor(null);
                        setResetPass("");
                      }}
                    >
                      Cancel
                    </Button>
                  </View>
                </View>
              ) : (
                <View style={[s.row, { gap: 8, marginTop: 10, flexWrap: "wrap" }]}>
                  <Button small disabled={busy} onPress={() => setResetFor(u.username)}>
                    Reset password
                  </Button>
                  <Button small disabled={busy} onPress={() => void toggleRole(u)}>
                    Make {u.role === "admin" ? "user" : "admin"}
                  </Button>
                  <Button small disabled={busy} onPress={() => void toggleDisabled(u)}>
                    {u.disabled ? "Enable" : "Disable"}
                  </Button>
                  {u.username !== sessionUser.username && (
                    <Button small disabled={busy} onPress={() => void removeUser(u.username)}>
                      <Trash2 size={14} color={colors.danger} />
                    </Button>
                  )}
                </View>
              )}
            </Card>
          ))
        )}
      </View>
    </View>
  );
}
