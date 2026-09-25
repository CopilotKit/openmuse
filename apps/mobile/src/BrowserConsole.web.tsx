export default function BrowserConsole({ url }: { url: string }) {
  return (
    <iframe
      title="Remote browser session console"
      src={url}
      style={{
        height: "clamp(550px, 76vh, 850px)",
        width: "100%",
        border: 0,
        borderRadius: 12,
        background: "#FFF",
      }}
    />
  );
}
