var http = require('node:http')

function headers(incoming) {
  var outgoing = Object.assign({}, incoming)
  var connection = incoming.connection || ''
  var remove = [
    'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'proxy-connection', 'te',
    'trailer', 'transfer-encoding', 'upgrade'
  ].concat(connection.toLowerCase().split(',').map(function (name) {
    return name.trim()
  }))
  remove.forEach(function (name) { delete outgoing[name] })
  return outgoing
}

module.exports = function createProxy(options) {
  var target = new URL(options.target)

  if (target.protocol !== 'http:') {
    throw new Error('Target must use http:')
  }

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

  var server = http.createServer(function (req, res) {
    var upstream = http.request(requestOptions(req))
    var response

    function fail() {
      upstream.destroy()
      if (response) response.destroy()
      if (res.destroyed) return
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('Bad Gateway\n')
    }

    req.on('error', fail)
    upstream.on('error', fail)
    res.on('error', fail)
    res.on('close', function () {
      upstream.destroy()
      if (response) response.destroy()
    })
    upstream.on('response', function (incoming) {
      response = incoming
      incoming.on('error', fail)
      res.writeHead(
        incoming.statusCode,
        incoming.statusMessage,
        headers(incoming.headers)
      )
      incoming.pipe(res)
    })
    req.pipe(upstream)
  })

  server.on('upgrade', function (req, socket, head) {
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      return socket.destroy()
    }

    var upstream = http.request(requestOptions(req, true))
    var remote
    var response
    var started = false

    function cleanup() {
      upstream.destroy()
      if (remote) remote.destroy()
      if (response) response.destroy()
    }

    function fail() {
      cleanup()
      if (started) return socket.destroy()
      started = true
      socket.end(
        'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n' +
          'Content-Length: 0\r\n\r\n'
      )
    }

    socket.on('error', cleanup)
    socket.on('close', cleanup)
    socket.on('end', cleanup)
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
      remote.on('error', fail)
      remote.on('close', function () { socket.destroy() })
      if (socket.destroyed) return cleanup()
      if ((incoming.headers.upgrade || '').toLowerCase() !== 'websocket') {
        return fail()
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
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) remote.write(head)
      remote.pipe(socket)
      socket.pipe(remote)
    })
    upstream.end()
  })

  return server
}
