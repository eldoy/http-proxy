var http = require('node:http')
var http2 = require('node:http2')

function headers(incoming) {
  var outgoing = Object.assign({}, incoming)
  var connection = incoming.connection || ''

  var remove = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ].concat(connection.toLowerCase().split(',').map(function (name) {
    return name.trim()
  }))

  remove.forEach(function (name) {
    delete outgoing[name]
  })

  Object.keys(outgoing).forEach(function (name) {
    if (name.startsWith(':')) delete outgoing[name]
  })

  return outgoing
}

module.exports = function createProxy(options) {
  var target = new URL(options.target)
  var createServer = options.tls ? http2.createSecureServer : http.createServer
  var tls = Object.assign({ allowHTTP1: true }, options.tls)

  function requestOptions(req, upgrade) {
    var outgoing = headers(req.headers)

    if (upgrade) {
      outgoing.connection = 'Upgrade'
      outgoing.upgrade = req.headers.upgrade
    }

    return {
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || 80,
      method: req.method,
      path: req.url,
      headers: outgoing
    }
  }

  var server = createServer(tls, async function (req, res) {
    var upstream
    var response
    var timedOut = false

    function fail(err) {
      if (upstream) {
        upstream.destroy()
      }

      if (response) {
        response.destroy()
      }

      if (res.destroyed || res.writableEnded) {
        return
      }

      if (res.headersSent) {
        return res.destroy()
      }

      res.writeHead(timedOut ? 504 : 502, {
        'content-type': 'text/plain; charset=utf-8'
      })
      res.end(String(err.message).replace(/[\r\n]+/g, ' ') + '\n')
    }

    req.on('error', fail)
    res.on('error', fail)

    res.on('close', function () {
      if (upstream) {
        upstream.destroy()
      }

      if (response) {
        response.destroy()
      }
    })

    try {
      if (req.httpVersionMajor === 2) {
        req.headers.host = req.headers[':authority']
      }

      if (options.before) {
        await options.before(req, res)
      }

      if (res.destroyed || res.writableEnded) {
        return
      }

      upstream = http.request(requestOptions(req))

      if (options.timeout) {
        upstream.setTimeout(options.timeout, function () {
          timedOut = true
          fail(new Error('Upstream timed out: ' + options.target))
        })
      }
    } catch (err) {
      return fail(err)
    }

    upstream.on('error', fail)

    upstream.on('response', function (incoming) {
      response = incoming
      incoming.on('error', fail)

      var outgoing = headers(incoming.headers)
      if (req.httpVersionMajor === 2) {
        res.writeHead(incoming.statusCode, outgoing)
      } else {
        res.writeHead(incoming.statusCode, incoming.statusMessage, outgoing)
      }

      incoming.pipe(res)
    })

    req.pipe(upstream)
  })

  server.on('upgrade', async function (req, socket, head) {
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      return socket.destroy()
    }

    var upstream
    var remote
    var response
    var started = false
    var timedOut = false

    function cleanup() {
      if (upstream) {
        upstream.destroy()
      }

      if (remote) {
        remote.destroy()
      }

      if (response) {
        response.destroy()
      }
    }

    function fail(err) {
      cleanup()

      if (socket.destroyed || socket.writableEnded) {
        return
      }

      if (started) {
        return socket.destroy()
      }

      started = true

      var status = timedOut ? '504 Gateway Timeout' : '502 Bad Gateway'
      var body = String(err.message).replace(/[\r\n]+/g, ' ') + '\n'

      socket.end(
        'HTTP/1.1 ' + status + '\r\nConnection: close\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n' +
          'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body
      )
    }

    socket.on('error', cleanup)
    socket.on('close', cleanup)
    socket.on('end', cleanup)
    socket.pause()

    try {
      if (options.before) {
        await options.before(req, socket)
      }

      if (socket.destroyed || socket.writableEnded) {
        return
      }

      upstream = http.request(requestOptions(req, true))

      if (options.timeout) {
        upstream.setTimeout(options.timeout, function () {
          timedOut = true
          fail(new Error('Upstream timed out: ' + options.target))
        })
      }
    } catch (err) {
      return fail(err)
    }

    upstream.on('error', fail)

    upstream.on('response', function (incoming) {
      response = incoming
      started = true

      var res = new http.ServerResponse(req)
      res.shouldKeepAlive = false
      res.assignSocket(socket)
      res.on('error', fail)
      incoming.on('error', fail)

      res.writeHead(
        incoming.statusCode,
        incoming.statusMessage,
        headers(incoming.headers)
      )

      incoming.pipe(res)
    })

    upstream.on('upgrade', function (incoming, upstreamSocket, upstreamHead) {
      remote = upstreamSocket
      remote.setTimeout(0)
      remote.on('error', fail)
      remote.on('close', function () {
        socket.destroy()
      })

      if (socket.destroyed) {
        return cleanup()
      }

      if ((incoming.headers.upgrade || '').toLowerCase() !== 'websocket') {
        return fail(new Error('Invalid upstream WebSocket upgrade'))
      }

      started = true

      var outgoing = headers(incoming.headers)
      var handshake = 'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n'

      for (var i = 0; i < incoming.rawHeaders.length; i += 2) {
        var name = incoming.rawHeaders[i]

        if (Object.hasOwn(outgoing, name.toLowerCase())) {
          handshake += name + ': ' + incoming.rawHeaders[i + 1] + '\r\n'
        }
      }

      socket.write(handshake + '\r\n')

      if (upstreamHead.length) {
        socket.write(upstreamHead)
      }

      if (head.length) {
        remote.write(head)
      }

      remote.pipe(socket)
      socket.pipe(remote)
    })

    upstream.end()
  })

  return server
}
