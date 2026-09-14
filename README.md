# HTTP Proxy

HTTP and WebSocket forwarding for development, using only Node.js built-ins.
Requires Node.js 24 or later. CommonJS, with the implementation in `index.js`.

## Usage

From the repository:

```js
var proxy = require('./index')

var server = proxy({ target: 'http://127.0.0.1:3000' })

server.listen(8080, '127.0.0.1')
```

`proxy({ target })` returns a standard Node.js HTTP server. Supply an HTTP
origin as the target, without a path, query, or credentials.

Requests retain their method, path, query, host, and forwarded headers.
Request and response bodies stream through the proxy. Responses retain their
status, cookies, and redirects. Connection-specific headers are filtered.
WebSocket upgrades and traffic pass through automatically.

An unavailable app returns `502 Bad Gateway`. If a response has already
started, an upstream failure closes the connection.

## Behind a reverse proxy

This module runs independently. Optionally place a server such as Caddy or
nginx in front: `client → reverse proxy → this proxy → app`.

Let the front server handle HTTPS and forward HTTP and WebSocket upgrades to
this proxy. Preserve the original host and set the forwarded headers there.
Both connections behind the front server use plain HTTP.

The examples use this proxy on `127.0.0.1:8080`, forwarding to an app on
`127.0.0.1:3000`, as in the usage example above. These addresses assume all
three processes run on the same machine.

### Caddy

Caddy forwards WebSocket upgrades and sets forwarded headers automatically.
Use your development hostname in the Caddyfile:

```caddyfile
dev.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

See the [Caddy reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

### nginx

Put this map in nginx's `http` context:

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}
```

Add this location to your development site's existing `server` block,
keeping its listener and certificate settings:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Host $http_host;
  proxy_set_header X-Forwarded-Host $http_host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_buffering off;
  proxy_request_buffering off;
}
```

The upgrade headers enable WebSockets, and disabling buffering lets request
and response bodies stream. For idle WebSocket connections, use app-level
ping frames or set `proxy_read_timeout` to the desired idle timeout.
See [nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html).

## Tests

```sh
npm test
npm run test:watch
```
