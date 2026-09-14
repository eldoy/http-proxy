var test = require('node:test')
var assert = require('node:assert/strict')
var http = require('node:http')
var https = require('node:https')
var tls = require('node:tls')
var crypto = require('node:crypto')
var once = require('node:events').once
var createProxy = require('../../index')

// Disposable localhost certificate and key used only by these tests.
var credentials = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgVMobQh6ZZMS0Bohs
2WweBQYmPkUTVqmgM9imI5LpSnehRANCAASFdMav+XM3KUnszjNB6bwa+Mti0U0K
u3yXSKjxFT4hSn1qFkOhAJ0Y6vYkMIbNrVbZBt8Xc1bl6VZRtGLJw96G
-----END PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBmDCCAT+gAwIBAgIUXIMeqHnl+CMGbZA03mhg8lt9qYowCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkxNDA0MjA0MVoXDTM2MDkxMTA0
MjA0MVowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEhXTGr/lzNylJ7M4zQem8GvjLYtFNCrt8l0io8RU+IUp9ahZDoQCdGOr2
JDCGza1W2QbfF3NW5elWUbRiycPehqNvMG0wHQYDVR0OBBYEFPMgMfraYjaZJDZ3
/sRELryaVjv8MB8GA1UdIwQYMBaAFPMgMfraYjaZJDZ3/sRELryaVjv8MA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49
BAMCA0cAMEQCIGx+LLvH7u/zFvg9soXi2buLbiyEIOZjB53+W+Nf78vMAiAUHAMT
9CWMxP2GLOyoOZIRpMGY8Dy43tU3c/XOA1n6rw==
-----END CERTIFICATE-----`
}

async function listen(t, server) {
  var sockets = new Set()
  server.on('connection', function (socket) {
    sockets.add(socket)
    socket.on('close', function () { sockets.delete(socket) })
  })
  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(function () {
    sockets.forEach(function (socket) { socket.destroy() })
    return new Promise(function (resolve) { server.close(resolve) })
  })
  return server.address().port
}

async function setup(t, app, before, secure) {
  var port = await listen(t, app)
  return listen(t, createProxy({
    target: 'http://127.0.0.1:' + port,
    before,
    tls: secure ? credentials : undefined
  }))
}


function request(port, options, body) {
  var transport = options && options.ca ? https : http

  return new Promise(function (resolve, reject) {
    var req = transport.request(Object.assign({ hostname: '127.0.0.1', port },
      options), function (res) {
      var chunks = []
      res.on('data', function (chunk) { chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('forwards HTTPS bodies, paths, headers, cookies and redirects', async function (t) {
  var payload = Buffer.from([0, 1, 127, 128, 255])
  var port = await setup(t, http.createServer(function (req, res) {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/a//b%2Fc?x=1&x=2')
    assert.equal(req.headers.host, 'dev.example')
    assert.equal(req.headers['x-forwarded-proto'], 'https')
    assert.equal(req.headers['x-forwarded-for'], '192.0.2.1')
    assert.equal(req.headers['x-private'], undefined)
    var chunks = []
    req.on('data', function (chunk) { chunks.push(chunk) })
    req.on('end', function () {
      assert.deepEqual(Buffer.concat(chunks), payload)
      res.writeHead(307, {
        location: '/next',
        'set-cookie': ['a=1', 'b=2'],
        connection: 'close, x-private',
        'x-private': 'remove'
      })
      res.end(payload)
    })
  }), undefined, true)
  var result = await request(port, {
    ca: credentials.cert,
    servername: 'localhost',
    method: 'POST', path: '/a//b%2Fc?x=1&x=2',
    headers: {
      host: 'dev.example', 'x-forwarded-proto': 'https',
      'x-forwarded-for': '192.0.2.1',
      connection: 'close, x-private', 'x-private': 'remove'
    }
  }, payload)
  assert.equal(result.status, 307)
  assert.equal(result.headers.location, '/next')
  assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2'])
  assert.equal(result.headers['x-private'], undefined)
  assert.deepEqual(result.body, payload)
})

test('returns 502 when the app is unavailable', async function (t) {
  var app = http.createServer()
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  var target = 'http://127.0.0.1:' + app.address().port
  await new Promise(function (resolve) { app.close(resolve) })
  var port = await listen(t, createProxy({ target }))
  var result = await request(port)
  assert.equal(result.status, 502)
})

test('awaits startup before forwarding and handles hook errors', async function (t) {
  var app = http.createServer(function (req, res) { req.pipe(res) })
  var appPort = await listen(t, app)
  await new Promise(function (resolve) { app.close(resolve) })
  var options = {
    target: 'http://127.0.0.1:' + appPort,
    before: async function () {
      await new Promise(function (resolve) { setImmediate(resolve) })
      await new Promise(function (resolve) {
        app.listen(appPort, '127.0.0.1', resolve)
      })
    }
  }
  var port = await listen(t, createProxy(options))
  var result = await request(port, { method: 'POST' }, 'pending body')
  assert.equal(result.status, 200)
  assert.equal(result.body.toString(), 'pending body')
  options.before = async function () { throw new Error('Startup failed') }
  assert.equal((await request(port)).status, 502)
})

test('forwards rejected WebSocket handshakes and bodies', async function (t) {
  var port = await setup(t, http.createServer(function (req, res) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.write('access ')
    res.end('denied')
  }))
  var req = http.request({ hostname: '127.0.0.1', port, headers: {
    connection: 'Upgrade', upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
  } })
  req.end()
  var res = (await once(req, 'response'))[0]
  var body = ''
  for await (var chunk of res) body += chunk
  assert.equal(res.statusCode, 403)
  assert.equal(body, 'access denied')
})

test('tunnels secure WebSockets, awaits readiness and cleans up', { timeout: 3000 }, async function (t) {
  var app = http.createServer()
  var ready = false
  var closed
  var ended = new Promise(function (resolve) { closed = resolve })
  var frame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 105, 107])
  var reply = Buffer.from([0x81, 2, 104, 105])
  app.on('upgrade', function (req, socket, head) {
    assert.equal(ready, true)
    assert.equal(req.url, '/socket?test=1')
    var accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] +
        '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.on('close', closed)
    socket.on('end', function () { socket.end() })
    socket.write(Buffer.concat([Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    ), reply]))
    var received = head
    function consume(chunk) {
      received = Buffer.concat([received, chunk])
      while (received.length >= frame.length) {
        assert.deepEqual(received.subarray(0, frame.length), frame)
        received = received.subarray(frame.length)
        socket.write(reply)
      }
    }
    socket.on('data', consume)
    consume(Buffer.alloc(0))
  })
  var port = await setup(t, app, async function () {
    await new Promise(function (resolve) { setImmediate(resolve) })
    ready = true
  }, true)
  var client = tls.connect({ host: '127.0.0.1', port, ca: credentials.cert })
  t.after(function () { client.destroy() })
  await once(client, 'secureConnect')
  assert.equal(client.authorized, true)
  client.write(Buffer.concat([Buffer.from(
    'GET /socket?test=1 HTTP/1.1\r\nHost: dev.example\r\n' +
    'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
    'Sec-WebSocket-Version: 13\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
  ), frame]))
  await new Promise(function (resolve, reject) {
    var data = Buffer.alloc(0)
    var sent = false
    client.on('error', reject)
    client.on('data', function (chunk) {
      data = Buffer.concat([data, chunk])
      var boundary = data.indexOf('\r\n\r\n')
      if (boundary < 0) return
      assert.match(data.subarray(0, boundary).toString(), /^HTTP\/1.1 101/)
      var body = data.subarray(boundary + 4)
      if (body.length >= reply.length * 2 && !sent) {
        sent = true
        client.write(frame)
      }
      if (body.length === reply.length * 3) {
        assert.deepEqual(body, Buffer.concat([reply, reply, reply]))
        client.destroy()
        resolve()
      }
    })
  })
  await ended
})
