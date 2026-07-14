const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 1982;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/WebSerialTerminal.html' : req.url;

  // 路径遍历防护
  const fullPath = path.join(ROOT, filePath);
  if (!fullPath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    const headers = { 'Content-Type': contentType };
    if (filePath === '/sw.js') {
      headers['Service-Worker-Allowed'] = '/';
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}).listen(PORT, () => {
  console.log(`WebTerm Pro running at http://localhost:${PORT}`);
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭占用进程后重试`);
    process.exit(1);
  }
  console.error('服务器启动失败:', err.message);
  process.exit(1);
});
