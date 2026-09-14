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

Use an optional `before` hook to start your dev app before forwarding:

```js
var server = proxy({
  target: 'http://127.0.0.1:3000',
  before: async function (req, res) {
    await ensureAppReady()
  }
})
```

Provide `ensureAppReady()` in your calling code. It should resolve when the
app is listening and return immediately if it is already running. The hook
runs for each HTTP request and WebSocket upgrade; its second argument is the
response for HTTP, or the socket for upgrades. Hook errors return `502`.

Requests retain their method, path, query, host, and forwarded headers.
Request and response bodies stream through the proxy. Responses retain their
status, cookies, and redirects. Connection-specific headers are filtered.
WebSocket upgrades and traffic pass through automatically.

An unavailable app returns `502 Bad Gateway`. If a response has already
started, an upstream failure closes the connection.

Set `timeout` in milliseconds to close an inactive upstream connection:

```js
var server = proxy({
  target: 'http://127.0.0.1:3000',
  timeout: 30000
})
```

This measures socket inactivity after connecting, not total request duration.
It returns `504 Gateway Timeout` if response headers have not been sent;
otherwise it closes the response. It also covers waiting for a WebSocket
upgrade, but not an established WebSocket or the `before` hook. Omitting
`timeout` (or setting it to `0`) adds no timeout.

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

## Local development certificates

[mkcert](https://github.com/FiloSottile/mkcert) creates a local certificate
authority (CA), installs it in your trust store, and signs development
certificates. It is a separate setup tool, not a dependency of this module.

On macOS with Homebrew:

```sh
brew install mkcert
mkcert -install
```

For Firefox, also install `nss` with Homebrew before running `mkcert -install`.
The trust installation may ask for your administrator password.

Create a certificate and key outside the repository:

```sh
mkdir -p ~/.config/http-proxy
mkcert -cert-file ~/.config/http-proxy/cert.pem \
  -key-file ~/.config/http-proxy/key.pem \
  localhost 127.0.0.1 ::1
```

These files cover `localhost` and the loopback IP addresses. Include any
custom development hostname in the command too, and configure it to resolve
to your machine. Keep the private keys local; never commit or share the CA's
`rootCA-key.pem`.

Pass the certificate and key through `tls` to serve HTTPS directly:

```js
var fs = require('node:fs')
var os = require('node:os')
var proxy = require('./index')
var directory = os.homedir() + '/.config/http-proxy'

var server = proxy({
  target: 'http://127.0.0.1:3000',
  tls: {
    key: fs.readFileSync(directory + '/key.pem'),
    cert: fs.readFileSync(directory + '/cert.pem')
  }
})

server.listen(8443, '127.0.0.1')
```

Open `https://localhost:8443`. WebSockets use `wss://localhost:8443` with
the app's WebSocket path. The upstream app continues using plain HTTP.
Omit `tls` to listen on HTTP. The optional `before` hook works in either mode.

## Tests

```sh
npm test
npm run test:watch
```
