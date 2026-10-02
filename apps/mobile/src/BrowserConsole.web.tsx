export default function BrowserConsole({
  url,
  title = "Remote browser session console",
}: {
  url: string;
  title?: string;
}) {
  return (
    <iframe
      title={title}
      src={url}
      style={{ height: 540, width: "100%", border: 0, borderRadius: 12, background: "#FFF" }}
    />
  );
}
