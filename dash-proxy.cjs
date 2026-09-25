const http = require("node:http");
const server = http.createServer((req, res) => {
  const proxyReq = http.request(
    {
      host: "127.0.0.1",
      port: 8090,
      path: req.url,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: "127.0.0.1:8090" }),
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("proxy error");
  });
  req.pipe(proxyReq);
});
server.listen(80, "0.0.0.0", () => console.log("dash proxy listening on 0.0.0.0:80"));
