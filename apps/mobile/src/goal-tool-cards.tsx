import { ArrowRight } from "lucide-react-native";
import { Text, View } from "react-native";
import { z } from "zod";
import type { Section } from "../../../packages/domain/src";
import { GoalCard, IdeaCard, MonitorCard, TaskLink } from "./agent-ui";
import { useAgentWorkspace } from "./agent-workspace";
import { Button, Card, Chip, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

// Tool results are only pointers. Every card reads the saved record from the polled
// workspace, so a milestone checked in chat or on the Goals tab shows in both places.
function parse<T extends z.ZodType>(schema: T, result: unknown): z.infer<T> | undefined {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
const savedResult = z.object({ id: z.string().optional(), error: z.string().optional() });

function ViewButton({ section, children }: { section: Section; children: string }) {
  const { navigate } = useWorkspace();
  return (
    <Button
      small
      icon={ArrowRight}
      style={{ alignSelf: "flex-start" }}
      onPress={() => navigate(section)}
    >
      {children}
    </Button>
  );
}
function PendingCard({
  heading,
  detail,
  error,
  section,
  view,
}: {
  heading: string;
  detail: string;
  error?: string;
  section: Section;
  view: string;
}) {
  return (
    <Card style={{ padding: 16, gap: 10 }}>
      <Text style={s.heading}>{heading}</Text>
      {error ? <ErrorNotice error={error} /> : <Text style={s.muted}>{detail}</Text>}
      <ViewButton section={section}>{view}</ViewButton>
    </Card>
  );
}

export function GoalToolCard({
  result,
  loading,
  updating,
}: {
  result: unknown;
  loading: boolean;
  updating?: boolean;
}) {
  const { data } = useAgentWorkspace();
  const saved = parse(savedResult, result);
  const goal = saved?.id ? data?.goals.find((item) => item.id === saved.id) : undefined;
  if (goal)
    return (
      <GoalCard goal={goal}>
        <ViewButton section="goals">View goal</ViewButton>
      </GoalCard>
    );
  return (
    <PendingCard
      heading={loading ? (updating ? "Updating goal…" : "Saving goal…") : "Goal"}
      detail={loading ? "Waiting for the server." : "Open Goals to see the saved result."}
      error={saved?.error}
      section="goals"
      view="View goal"
    />
  );
}

export function TrackingToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const { data } = useAgentWorkspace();
  const saved = parse(savedResult, result);
  const monitor = saved?.id ? data?.monitors.find((item) => item.id === saved.id) : undefined;
  if (monitor)
    return (
      <MonitorCard monitor={monitor}>
        <ViewButton section="goals">View tracking</ViewButton>
      </MonitorCard>
    );
  return (
    <PendingCard
      heading={loading ? "Saving tracking…" : "Tracking"}
      detail={loading ? "Waiting for the server." : "Open Goals to see the saved result."}
      error={saved?.error}
      section="goals"
      view="View tracking"
    />
  );
}

const ideasResult = z.object({
  ideas: z.array(z.object({ id: z.string(), title: z.string(), reason: z.string() })).default([]),
  more: z.number().default(0),
  error: z.string().optional(),
});

export function IdeasToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const { data } = useAgentWorkspace();
  const found = parse(ideasResult, result);
  if (loading || !found || found.error)
    return (
      <PendingCard
        heading={loading ? "Looking for ideas…" : "Ideas"}
        detail={loading ? "Checking your connected apps." : "Open Ideas to see suggestions."}
        error={found?.error}
        section="ideas"
        view="View ideas"
      />
    );
  return (
    <Card style={{ padding: 16, gap: 4 }}>
      <Text style={s.heading}>Ideas for you</Text>
      <Text style={s.small}>Inspired by your connected apps</Text>
      {found.ideas.map((summary) => {
        const idea = data?.ideas.find((item) => item.id === summary.id);
        if (idea?.status === "new") return <IdeaCard key={idea.id} idea={idea} />;
        return (
          <View
            key={summary.id}
            style={{
              paddingVertical: 14,
              gap: 7,
              borderBottomWidth: 1,
              borderBottomColor: colors.line,
            }}
          >
            <Text style={[s.heading, { fontSize: 16, lineHeight: 23 }]}>
              {idea?.title ?? summary.title}
            </Text>
            {idea?.status === "accepted" ? (
              <>
                <Chip tint={colors.green}>Started</Chip>
                {!!idea.taskId && <TaskLink taskId={idea.taskId} />}
              </>
            ) : idea?.status === "dismissed" ? (
              <Chip>Dismissed</Chip>
            ) : (
              <Text style={s.muted}>{summary.reason}</Text>
            )}
          </View>
        );
      })}
      {!found.ideas.length && (
        <Text style={[s.muted, { paddingVertical: 10 }]}>
          Nothing new to suggest right now. Ideas come from the apps and goals you’ve shared.
        </Text>
      )}
      {found.more > 0 && (
        <Text style={[s.small, { paddingTop: 8 }]}>{found.more} more on the Ideas tab</Text>
      )}
      <View style={{ paddingTop: 10 }}>
        <ViewButton section="ideas">View ideas</ViewButton>
      </View>
    </Card>
  );
}
