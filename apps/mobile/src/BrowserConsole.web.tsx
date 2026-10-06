export default function BrowserConsole({
  url,
  title = "Remote browser session console",
  sandboxed = false,
}: {
  url: string;
  title?: string;
  sandboxed?: boolean;
}) {
  return (
    <iframe
      title={title}
      src={url}
      sandbox={sandboxed ? "allow-scripts allow-same-origin allow-pointer-lock" : undefined}
      referrerPolicy={sandboxed ? "no-referrer" : undefined}
      style={{ height: 540, width: "100%", border: 0, borderRadius: 12, background: "#FFF" }}
    />
  );
}
