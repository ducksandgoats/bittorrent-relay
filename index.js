import Debug from 'debug'
import EventEmitter from 'events'
import http from 'http'
import peerid from 'bittorrent-peerid'
import series from 'run-series'
import string2compact from 'string2compact'
import { WebSocketServer, WebSocket } from 'ws'
import DHT from 'bittorrent-dht'
import { hex2bin } from 'uint8-util'
import pidusage from 'pidusage'
import common from './lib/common.js'
import Swarm from './lib/swarm.js'
import parseWebSocketRequest from './lib/parse-websocket.js'
import crypto from 'crypto'
import {nanoid} from 'nanoid'

const debug = Debug('bittorrent-tracker:server')
const hasOwnProperty = Object.prototype.hasOwnProperty

/**
 * BitTorrent tracker server.
 *
 * HTTP service which responds to GET requests from torrent clients. Requests include
 * metrics from clients that help the tracker keep overall statistics about the torrent.
 * Responses include a peer list that helps the client participate in the torrent.
 *
 * @param {Object}  opts                options object
 * @param {Number}  opts.announceTimer       tell clients to announce on this interval (ms)
 * @param {Number}  opts.relayTimer       interval to find and connect to other trackers (ms)
 * @param {Number}  opts.timer       interval for general things like checking for active and inactive connections (ms)
 * @param {Number}  opts.dhtPort      port used for the dht
 * @param {Number}  opts.trackerPort     port used for the tracker
 * @param {String}  opts.dhtHost     host used for the dht
 * @param {String}  opts.trackerHost     host used for the tracker
 * @param {String}  opts.domain     domain name that will be used
 * @param {Boolean}  opts.trustProxy     trust 'x-forwarded-for' header from reverse proxy
 */

class Server extends EventEmitter {
  constructor (opts = {}) {
    super()
    debug('new server %s', JSON.stringify(opts))
    
    this.intervalMs = opts.announceTimer
      ? opts.announceTimer
      : 10 * 60 * 1000 // 10 min

    this.peersCacheLength = opts.peersCacheLength
    this.peersCacheTtl = opts.peersCacheTtl
    this.destroyed = false
    this.torrents = {}

    this.http = null
    this.ws = null

    // this.cpuLimit = 100
    // this.memLimit = 1700000000
    this.timer = opts.timer || 1 * 60 * 1000
    this.relayTimer = opts.relayTimer ? opts.relayTimer : 5 * 60 * 1000
    this.DHTPORT = opts.dhtPort || 16881
    this.TRACKERPORT = opts.trackerPort || 16969
    this.DHTHOST = opts.dhtHost || '0.0.0.0'
    this.TRACKERHOST = opts.trackerHost || '0.0.0.0'
    this.hashes = (() => {if(!opts.hashes){return [];}return Array.isArray(opts.hashes) ? opts.hashes : opts.hashes.split(',');})()
    if(!this.hashes.length){
      throw new Error('hashes can not be empty')
    }
    this.relays = this.hashes.map((data) => {return crypto.createHash('sha1').update(data + "'s").digest('hex')})
    // this._trustProxy = !!opts.trustProxy
    this._trustProxy = Boolean(opts.trustProxy)
    // if (typeof opts.filter === 'function') this._filter = opts.filter
    this._filter = function (infoHash, params, cb) {
      // const hashes = (() => {if(!opts.hashes){throw new Error('must have hashes')}return Array.isArray(opts.hashes) ? opts.hashes : opts.hashes.split(',')})()
      if(this.hashes.includes(infoHash)){
        cb(null)
      } else {
        cb(new Error('disallowed torrent'))
      }
    }

    this.domain = opts.domain || null
    this.id = crypto.createHash('sha1').update(nanoid()).digest('hex')
    this.dht = {host: this.DHTHOST, port: this.DHTPORT}
    this.tracker = {host: this.TRACKERHOST, port: this.TRACKERPORT}
    this.web = `ws://${this.domain || this.TRACKERHOST}:${this.TRACKERPORT}`
    this.status = {cpu: 0, memory: 0, state: 1}
    this.trackers = {}
    this.sendTo = {}
    this.hashes.forEach((data) => {this.sendTo[data] = []})

    // start a websocket tracker (for WebTorrent) unless the user explicitly says no
    const self = this
    this.http = http.createServer()
    this.http.onError = (err) => {
      self.emit('error', 'http', err)
    }
    this.http.onListening = () => {
      debug('listening')
      self.tracker = self.http.address()
      self.id = crypto.createHash('sha1').update(`${self.domain || self.tracker.address}:${self.tracker.port}`).digest('hex')
      self.web = `ws://${self.domain || self.tracker.address}:${self.tracker.port}`
      for(const socket in self.trackers){
        if(self.trackers[socket].readyState === 1){
          self.trackers[socket].send(JSON.stringify({action: 'web', tracker: self.tracker, dht: self.dht, domain: self.domain, web: self.web, trackerHost: self.TRACKERHOST, trackerPort: self.TRACKERPORT, dhtHost: self.DHTHOST, dhtPort: self.DHTPORT}))
        }
      }
      self.talkToRelay()
      self.emit('listening', 'http')
    }
    this.http.onRequest = (req, res) => {
      if (res.headersSent) return

      const infoHashes = Object.keys(self.torrents)
      let activeTorrents = 0
      const allPeers = {}
  
      function countPeers (filterFunction) {
        let count = 0
        let key
  
        for (key in allPeers) {
          if (hasOwnProperty.call(allPeers, key) && filterFunction(allPeers[key])) {
            count++
          }
        }
  
        return count
      }
  
      function groupByClient () {
        const clients = {}
        for (const key in allPeers) {
          if (hasOwnProperty.call(allPeers, key)) {
            const peer = allPeers[key]
  
            if (!clients[peer.client.client]) {
              clients[peer.client.client] = {}
            }
            const client = clients[peer.client.client]
            // If the client is not known show 8 chars from peerId as version
            const version = peer.client.version || Buffer.from(peer.peerId, 'hex').toString().substring(0, 8)
            if (!client[version]) {
              client[version] = 0
            }
            client[version]++
          }
        }
        return clients
      }
  
      function printClients (clients) {
        let html = '<ul>\n'
        for (const name in clients) {
          if (hasOwnProperty.call(clients, name)) {
            const client = clients[name]
            for (const version in client) {
              if (hasOwnProperty.call(client, version)) {
                html += `<li><strong>${name}</strong> ${version} : ${client[version]}</li>\n`
              }
            }
          }
        }
        html += '</ul>'
        return html
      }
  
      if (req.method === 'GET' && (req.url === '/stats' || req.url === '/stats.json')) {
        infoHashes.forEach(infoHash => {
          const peers = self.torrents[infoHash].peers
          const keys = peers.keys
          if (keys.length > 0) activeTorrents++
  
          keys.forEach(peerId => {
            // Don't mark the peer as most recently used for stats
            const peer = peers.peek(peerId)
            if (peer == null) return // peers.peek() can evict the peer
  
            if (!hasOwnProperty.call(allPeers, peerId)) {
              allPeers[peerId] = {
                ipv4: false,
                ipv6: false,
                seeder: false,
                leecher: false
              }
            }
  
            if (peer.ip.includes(':')) {
              allPeers[peerId].ipv6 = true
            } else {
              allPeers[peerId].ipv4 = true
            }
  
            if (peer.complete) {
              allPeers[peerId].seeder = true
            } else {
              allPeers[peerId].leecher = true
            }
  
            allPeers[peerId].peerId = peer.peerId
            allPeers[peerId].client = peerid(peer.peerId)
          })
        })
  
        const isSeederOnly = peer => peer.seeder && peer.leecher === false
        const isLeecherOnly = peer => peer.leecher && peer.seeder === false
        const isSeederAndLeecher = peer => peer.seeder && peer.leecher
        const isIPv4 = peer => peer.ipv4
        const isIPv6 = peer => peer.ipv6
  
        const stats = {
          torrents: infoHashes.length,
          activeTorrents,
          peersAll: Object.keys(allPeers).length,
          peersSeederOnly: countPeers(isSeederOnly),
          peersLeecherOnly: countPeers(isLeecherOnly),
          peersSeederAndLeecher: countPeers(isSeederAndLeecher),
          peersIPv4: countPeers(isIPv4),
          peersIPv6: countPeers(isIPv6),
          clients: groupByClient()
        }
  
        if (req.url === '/stats.json' || req.headers.accept === 'application/json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(stats))
        } else if (req.url === '/stats') {
          res.setHeader('Content-Type', 'text/html')
          res.end(`
            <h1>${stats.torrents} torrents (${stats.activeTorrents} active)</h1>
            <h2>Connected Peers: ${stats.peersAll}</h2>
            <h3>Peers Seeding Only: ${stats.peersSeederOnly}</h3>
            <h3>Peers Leeching Only: ${stats.peersLeecherOnly}</h3>
            <h3>Peers Seeding & Leeching: ${stats.peersSeederAndLeecher}</h3>
            <h3>IPv4 Peers: ${stats.peersIPv4}</h3>
            <h3>IPv6 Peers: ${stats.peersIPv6}</h3>
            <h3>Clients:</h3>
            ${printClients(stats.clients)}
          `.replace(/^\s+/gm, '')) // trim left
        }
      } else if(req.method === 'GET' && req.url === '/i'){
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(self.sendTo))
      } else if(req.method === 'GET' && req.url.startsWith('/i/')){
        const test = req.url.replace('/i/', '')
        res.setHeader('Content-Type', 'application/json')
        res.end(self.sendTo[test] ? JSON.stringify(self.sendTo[test]) : JSON.stringify([]))
      } else {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify('error'))
      }
    }
    this.http.onClose = () => {
      self.emit('close', 'http')
    }

    this.http.on('error', this.http.onError)
    this.http.on('listening', this.http.onListening)
    this.http.on('request', this.http.onRequest)
    this.http.on('close', this.http.onClose)

    // Add default http request handler on next tick to give user the chance to add
    // their own handler first. Handle requests untouched by user's handler.
    this.ws = new WebSocketServer({
      perMessageDeflate: false,
      clientTracking: false,
      ...(isObject(opts.ws) ? opts.ws : {}),
      server: this.http
    })
    this.ws.onError = (err) => {
      self.emit('error', 'ws', err)
    }
    this.ws.onConnection = (socket, req) => {
      // Note: socket.upgradeReq was removed in ws@3.0.0, so re-add it.
      // https://github.com/websockets/ws/pull/1099

      // if resource usage is high, send only the url of another tracker
      // else handle websockets as usual
      try {
        const action = req.url.slice(0, req.url.lastIndexOf('/')).slice(1)
        const hash = req.url.slice(req.url.lastIndexOf('/')).slice(1)
        if(action === 'announce'){
          if(self.status.state !== 1 && self.sendTo[hash] && self.sendTo[hash].length){
            // send them tracker url that is usable then close the socket
            socket.send(JSON.stringify({action: 'relay', tracker: self.sendTo[hash][Math.floor(Math.random() * self.sendTo[hash].length)]}))
            socket.terminate()
          } else {
            // use regular socket function from bittorrent-tracker
            socket.upgradeReq = req
            self.onWebSocketConnection(socket)
          }
        } else if(action === 'relay'){
          if(self.trackers[hash]){
            socket.terminate()
          } else {
            socket.id = hash
            socket.active = true
            socket.relays = []
            socket.hashes = []
            self.onRelaySocketConnection(socket)
          }
        } else {
          throw new Error('invalid path')
        }
      } catch (error) {
        socket.send(JSON.stringify({action: 'failure reason', error: error.message}))
        socket.terminate()
      }
    }
    this.ws.onClose = () => {
      self.emit('close', 'ws')
    }
    this.ws.onListening = () => {
      self.ws.listening = true
      self.emit('listening', 'ws')
    }
    this.ws.on('listening', this.ws.onListening)
    this.ws.on('close', this.ws.onClose)
    this.ws.on('error', this.ws.onError)
    this.ws.on('connection', this.ws.onConnection)

    // this.intervalUsage(60000)

    this.relay = new DHT()
    this.relay.onListening = () => {
      self.dht = self.relay.address()
      self.emit('listening', 'relay')
    }
    this.relay.onReady = () => {
      self.emit('ready', 'relay')
    }
    this.relay.onError = (err) => {
      self.emit('error', 'relay', err)
    }
    this.relay.onClose = () => {
      self.emit('close', 'relay')
    }
    this.relay.on('ready', this.relay.onReady)
    this.relay.on('listening', this.relay.onListening)
    this.relay.on('error', this.relay.onError)
    this.relay.on('close', this.relay.onClose)
    
    this.relay.on('peer', (peer, infoHash, from) => {
      // if not connected, then connect socket
      // share resource details on websocket
      // this.tracker[infoHash][ws-link]
      const relay = `ws://${peer.host}:${peer.port}/relay/`
      // const announce = `ws://${link}/announce/`
      const con = new WebSocket(relay + self.id)
      // con.relay = relay
      // con.announce = announce
      // con.id = id
      con.active = true
      // con.link = link
      con.relays = [infoHash]
      con.hashes = []
      // this.trackers[id] = con
      self.onRelaySocketConnection(con)
      // finish the rest
    })
    // this.relay.on('announce', (peer, infoHash) => {
    // // if not connected, then connect socket
    // // share resource details on websocket
    // })

    // this.talkToRelay()

    this.intervalRelay = setInterval(() => {
      if(this.http.listening){
        this.talkToRelay()
      }
    }, this.relayTimer)

    this.intervalActive = setInterval(() => {
      for(const test in this.trackers){
        if(!this.trackers[test].active){
          this.trackers[test].terminate()
          continue
        }
        this.trackers[test].active = false
        this.trackers[test].send(JSON.stringify({action: 'ping'}))
      }
    }, this.timer)

    this.intervalUsage(60000)
  }

  talkToRelay(){
    for(const test of this.relays){
      this.relay.lookup(test, (err, num) => {
          console.log(err, num)
      })
      this.relay.announce(test, this.TRACKERPORT, (err) => {
          console.log(err)
      })
    }
  }

  compute(cb) {
    const self = this
    pidusage(process.pid, function (err, stats) {
      if(err){
        self.emit('error', 'relay', err)
      } else if(stats){
        if(stats.cpu >= 95 || stats.memory >= 1615000000){
          // if(stats.cpu <= 95 || stats.memory <= 1615000000){
          //   close
          // }
          self.close()
          self.status = {...stats, state: 3}
        } else if((stats.cpu >= 85 && stats.cpu < 95) || (stats.memory >= 1445000000 && stats.memory < 1615000000)){
          self.listen()
          self.status = {...stats, state: 2}
        } else {
          self.listen()
          self.status = {...stats, state: 1}
        }
        for(const track in self.trackers){
          self.trackers[track].send(JSON.stringify({action: 'status', ...self.status}))
        }
        // send url of another tracker before closing server, if no tracker is available then close server
      } else {
        self.emit('error', 'relay', new Error('no error, no stats'))
      }
      // => {
      //   cpu: 10.0,            // percentage (from 0 to 100*vcore)
      //   memory: 357306368,    // bytes
      //   ppid: 312,            // PPID
      //   pid: 727,             // PID
      //   ctime: 867000,        // ms user + system time
      //   elapsed: 6650000,     // ms since the start of the process
      //   timestamp: 864000000  // ms since epoch
      // }
      cb()
    })
  }
  
  intervalUsage(time) {
    const self = this
    setTimeout(function(){
      self.compute(function() {
        self.intervalUsage(time)
      })
    }, time)
  }

  turnOn(cb){
    if(!this.relay.listening){
      this.relay.listen(this.DHTPORT, this.DHTHOST)
    }
    if(!this.http.listening){
      this.http.listen(this.TRACKERPORT, this.TRACKERHOST)
    }
    if(cb){
      cb()
    }
  }

  listen (){
    if(!this.http.listening){
      // this.http.on('error', this.http.onError)
      // this.http.on('listening', this.http.onListening)
      // this.http.on('request', this.http.onRequest)
      // this.http.on('close', this.http.onClose)
      this.http.listen(this.TRACKERPORT, this.TRACKERHOST)
    }
  }

  close () {
    debug('close')
    // const self = this
    if(this.http.listening){
      // this.http.off('error', this.http.onError)
      // this.http.off('listening', this.http.onListening)
      // this.http.off('request', this.http.onRequest)
      // this.http.off('close', this.http.onClose)
      this.http.close()
    }
    // this.destroyed = true
  }

  turnOff(cb){
    if(this.ws.listening){
      this.ws.close()
    }
    if(this.http.listening){
      this.http.close()
    }
    if(this.relay.listening){
      this.relay.destroy()
    }
    if(cb){
      cb()
    }
  }

  createSwarm (infoHash, cb) {
    if (ArrayBuffer.isView(infoHash)) infoHash = infoHash.toString('hex')

    process.nextTick(() => {
      const swarm = this.torrents[infoHash] = new Server.Swarm(infoHash, this)
      cb(null, swarm)
    })
  }

  getSwarm (infoHash, cb) {
    if (ArrayBuffer.isView(infoHash)) infoHash = infoHash.toString('hex')

    process.nextTick(() => {
      cb(null, this.torrents[infoHash])
    })
  }

  onRelaySocketConnection(socket){
    // if id sent from messages exists already in this.trackers then close the socket
    const self = this
    socket.takeOff = function(){
      socket.off('open', socket.onOpen)
      socket.off('error', socket.onError)
      socket.off('data', socket.onData)
      socket.off('close', socket.onClose)
    }
    socket.onOpen = function(){
      // self.trackers[socket.id] = socket
      socket.send(JSON.stringify({id: self.id, tracker: self.tracker, trackerHost: self.TRACKERHOST, trackerPort: self.TRACKERPORT, dhtHost: self.DHTHOST, dhtPort: self.DHTPORT, web: self.web, dht: self.dht, domain: self.domain, relays: self.relays, hashes: self.hashes, action: 'session'}))
    }
    socket.onError = function(err){
      self.emit('error', 'ws', err)
      socket.terminate()
    }
    socket.onData = function(data, buffer){
      const message = buffer ? JSON.parse(Buffer.from(data).toString('utf-8')) : JSON.parse(data)
      if(message.action === 'session'){
        if(self.trackers[message.id]){
          socket.terminate()
        }
        socket.id = message.id
        socket.domain = message.domain
        socket.tracker = message.tracker
        socket.web = message.web
        socket.dht = message.dht
        socket.relay = message.web + '/relay'
        socket.announce = message.web + '/announce'
        socket.dhtHost = message.dhtHost
        socket.dhtPort = message.dhtPort
        socket.trackerHost = message.trackerHost
        socket.trackerPort = message.trackerPort
        for(const messageRelay of message.relays){
          if(self.relays.includes(messageRelay)){
            if(!socket.relays.includes(messageRelay)){
              socket.relays.push(messageRelay)
            }
          }
        }
        for(const messageHash of message.hashes){
          if(self.hashes.includes(messageHash)){
            if(!socket.hashes.includes(messageHash)){
              socket.hashes.push(messageHash)
            }
          }
        }
      }
      if(message.action === 'web'){
        if(socket.domain !== message.domain){
          socket.domain = message.domain
        }
        if(socket.tracker.address !== message.tracker.address || socket.tracker.port !== message.tracker.port){
          socket.tracker = message.tracker
        }
        if(socket.dht.address !== message.dht.address || socket.dht.port !== message.dht.port){
          socket.dht = message.dht
        }
        if(socket.web !== message.web){
          for(const messageHash of socket.hashes){
            const useLink = socket.announce + '/' + messageHash
            if(self.sendTo[messageHash].includes(useLink)){
              self.sendTo[messageHash].splice(self.sendTo[messageHash].indexOf(useLink), 1)
              self.sendTo[messageHash].push(message.web + '/announce/' + messageHash)
            }
          }
          socket.web = message.web
          socket.relay = message.web + '/relay'
          socket.announce = message.web + '/announce'
        }
        if(socket.trackerHost !== message.trackerHost){
          socket.trackerHost = message.trackerHost
        }
        if(socket.trackerPort !== message.trackerPort){
          socket.trackerPort = message.trackerPort
        }
        if(socket.dhtHost !== message.dhtHost){
          socket.dhtHost = message.dhtHost
        }
        if(socket.dhtPort !== message.dhtPort){
          socket.dhtPort = message.dhtPort
        }
      }
      if(message.action === 'status'){
        if(message.state === 1){
          for(const messageHash of socket.hashes){
            const useLink = socket.announce + '/' + messageHash
            if(!self.sendTo[messageHash].includes(useLink)){
              self.sendTo[messageHash].push(useLink)
            }
          }
        } else {
          for(const messageHash of socket.hashes){
            const useLink = socket.announce + '/' + messageHash
            if(self.sendTo[messageHash].includes(useLink)){
              self.sendTo[messageHash].splice(self.sendTo[messageHash].indexOf(useLink), 1)
            }
          }
        }
        socket.status = message
      }
      if(message.action === 'hash'){
        if(self.relays.includes(message.relay)){
          if(!socket.relays.includes(message.relay)){
            socket.relays.push(message.relay)
          }
        }
        if(self.hashes.includes(message.hash)){
          if(!socket.hashes.includes(message.hash)){
            socket.hashes.push(message.hash)
          }
        }
      }
      if(message.action === 'ping'){
        socket.send(JSON.stringify({action: 'pong'}))
      }
      if(message.action === 'pong'){
        socket.active = true
      }
    }
    socket.onClose = function(code, reason){
      socket.takeOff()
      console.log(code, reason)
      delete self.trackers[socket.id]
    }
    socket.on('open', socket.onOpen)
    socket.on('error', socket.onError)
    socket.on('data', socket.onData)
    socket.on('close', socket.onClose)
  }

  onWebSocketConnection (socket, opts = {}) {
    opts.trustProxy = opts.trustProxy || this._trustProxy

    socket.peerId = null // as hex
    socket.infoHashes = [] // swarms that this socket is participating in
    socket.onSend = err => {
      this._onWebSocketSend(socket, err)
    }

    socket.onMessageBound = params => {
      this._onWebSocketRequest(socket, opts, params)
    }
    socket.on('message', socket.onMessageBound)

    socket.onErrorBound = err => {
      this._onWebSocketError(socket, err)
    }
    socket.on('error', socket.onErrorBound)

    socket.onCloseBound = () => {
      this._onWebSocketClose(socket)
    }
    socket.on('close', socket.onCloseBound)
  }

  _onWebSocketRequest (socket, opts, params) {
    try {
      params = parseWebSocketRequest(socket, opts, params)
    } catch (err) {
      socket.send(JSON.stringify({
        'failure reason': err.message
      }), socket.onSend)

      // even though it's an error for the client, it's just a warning for the server.
      // don't crash the server because a client sent bad data :)
      this.emit('warning', err)
      return
    }

    if (!socket.peerId) socket.peerId = params.peer_id // as hex

    this._onRequest(params, (err, response) => {
      if (this.destroyed || socket.destroyed) return
      if (err) {
        socket.send(JSON.stringify({
          action: params.action === common.ACTIONS.ANNOUNCE ? 'announce' : 'scrape',
          'failure reason': err.message,
          info_hash: hex2bin(params.info_hash)
        }), socket.onSend)

        this.emit('warning', err)
        return
      }

      response.action = params.action === common.ACTIONS.ANNOUNCE ? 'announce' : 'scrape'

      let peers
      if (response.action === 'announce') {
        peers = response.peers
        delete response.peers

        if (!socket.infoHashes.includes(params.info_hash)) {
          socket.infoHashes.push(params.info_hash)
        }

        response.info_hash = hex2bin(params.info_hash)

        // WebSocket tracker should have a shorter interval – default: 2 minutes
        response.interval = Math.ceil(this.intervalMs / 1000 / 5)
      }

      // Skip sending update back for 'answer' announce messages – not needed
      if (!params.answer) {
        socket.send(JSON.stringify(response), socket.onSend)
        debug('sent response %s to %s', JSON.stringify(response), params.peer_id)
      }

      if (Array.isArray(params.offers)) {
        debug('got %s offers from %s', params.offers.length, params.peer_id)
        debug('got %s peers from swarm %s', peers.length, params.info_hash)
        peers.forEach((peer, i) => {
          peer.socket.send(JSON.stringify({
            action: 'announce',
            offer: params.offers[i].offer,
            offer_id: params.offers[i].offer_id,
            peer_id: hex2bin(params.peer_id),
            info_hash: hex2bin(params.info_hash)
          }), peer.socket.onSend)
          debug('sent offer to %s from %s', peer.peerId, params.peer_id)
        })
      }

      const done = () => {
        // emit event once the announce is fully "processed"
        if (params.action === common.ACTIONS.ANNOUNCE) {
          this.emit(common.EVENT_NAMES[params.event], params.peer_id, params)
        }
      }

      if (params.answer) {
        debug('got answer %s from %s', JSON.stringify(params.answer), params.peer_id)

        this.getSwarm(params.info_hash, (err, swarm) => {
          if (this.destroyed) return
          if (err) return this.emit('warning', err)
          if (!swarm) {
            return this.emit('warning', new Error('no swarm with that `info_hash`'))
          }
          // Mark the destination peer as recently used in cache
          const toPeer = swarm.peers.get(params.to_peer_id)
          if (!toPeer) {
            return this.emit('warning', new Error('no peer with that `to_peer_id`'))
          }

          toPeer.socket.send(JSON.stringify({
            action: 'announce',
            answer: params.answer,
            offer_id: params.offer_id,
            peer_id: hex2bin(params.peer_id),
            info_hash: hex2bin(params.info_hash)
          }), toPeer.socket.onSend)
          debug('sent answer to %s from %s', toPeer.peerId, params.peer_id)

          done()
        })
      } else {
        done()
      }
    })
  }

  _onWebSocketSend (socket, err) {
    if (err) this._onWebSocketError(socket, err)
  }

  _onWebSocketClose (socket) {
    debug('websocket close %s', socket.peerId)
    socket.destroyed = true

    if (socket.peerId) {
      socket.infoHashes.slice(0).forEach(infoHash => {
        const swarm = this.torrents[infoHash]
        if (swarm) {
          swarm.announce({
            type: 'ws',
            event: 'stopped',
            numwant: 0,
            peer_id: socket.peerId
          })
        }
      })
    }

    // ignore all future errors
    socket.onSend = noop
    socket.on('error', noop)

    socket.peerId = null
    socket.infoHashes = null

    if (typeof socket.onMessageBound === 'function') {
      socket.removeListener('message', socket.onMessageBound)
    }
    socket.onMessageBound = null

    if (typeof socket.onErrorBound === 'function') {
      socket.removeListener('error', socket.onErrorBound)
    }
    socket.onErrorBound = null

    if (typeof socket.onCloseBound === 'function') {
      socket.removeListener('close', socket.onCloseBound)
    }
    socket.onCloseBound = null
  }

  _onWebSocketError (socket, err) {
    debug('websocket error %s', err.message || err)
    this.emit('warning', err)
    this._onWebSocketClose(socket)
  }

  _onRequest (params, cb) {
    if (params && params.action === common.ACTIONS.CONNECT) {
      cb(null, { action: common.ACTIONS.CONNECT })
    } else if (params && params.action === common.ACTIONS.ANNOUNCE) {
      this._onAnnounce(params, cb)
    } else if (params && params.action === common.ACTIONS.SCRAPE) {
      this._onScrape(params, cb)
    } else {
      cb(new Error('Invalid action'))
    }
  }

  _onAnnounce (params, cb) {
    const self = this

    if (this._filter) {
      this._filter(params.info_hash, params, err => {
        // Presence of `err` means that this announce request is disallowed
        if (err) return cb(err)

        getOrCreateSwarm((err, swarm) => {
          if (err) return cb(err)
          announce(swarm)
        })
      })
    } else {
      getOrCreateSwarm((err, swarm) => {
        if (err) return cb(err)
        announce(swarm)
      })
    }

    // Get existing swarm, or create one if one does not exist
    function getOrCreateSwarm (cb) {
      self.getSwarm(params.info_hash, (err, swarm) => {
        if (err) return cb(err)
        if (swarm) return cb(null, swarm)
        self.createSwarm(params.info_hash, (err, swarm) => {
          if (err) return cb(err)
          cb(null, swarm)
        })
      })
    }

    function announce (swarm) {
      if (!params.event || params.event === 'empty') params.event = 'update'
      swarm.announce(params, (err, response) => {
        if (err) return cb(err)

        if (!response.action) response.action = common.ACTIONS.ANNOUNCE
        if (!response.interval) response.interval = Math.ceil(self.intervalMs / 1000)

        if (params.compact === 1) {
          const peers = response.peers

          // Find IPv4 peers
          response.peers = string2compact(peers.filter(peer => common.IPV4_RE.test(peer.ip)).map(peer => `${peer.ip}:${peer.port}`))
          // Find IPv6 peers
          response.peers6 = string2compact(peers.filter(peer => common.IPV6_RE.test(peer.ip)).map(peer => `[${peer.ip}]:${peer.port}`))
        } else if (params.compact === 0) {
          // IPv6 peers are not separate for non-compact responses
          response.peers = response.peers.map(peer => ({
            'peer id': hex2bin(peer.peerId),
            ip: peer.ip,
            port: peer.port
          }))
        } // else, return full peer objects (used for websocket responses)

        cb(null, response)
      })
    }
  }

  _onScrape (params, cb) {
    if (params.info_hash == null) {
      // if info_hash param is omitted, stats for all torrents are returned
      // TODO: make this configurable!
      params.info_hash = Object.keys(this.torrents)
    }

    series(params.info_hash.map(infoHash => cb => {
      this.getSwarm(infoHash, (err, swarm) => {
        if (err) return cb(err)
        if (swarm) {
          swarm.scrape(params, (err, scrapeInfo) => {
            if (err) return cb(err)
            cb(null, {
              infoHash,
              complete: (scrapeInfo && scrapeInfo.complete) || 0,
              incomplete: (scrapeInfo && scrapeInfo.incomplete) || 0
            })
          })
        } else {
          cb(null, { infoHash, complete: 0, incomplete: 0 })
        }
      })
    }), (err, results) => {
      if (err) return cb(err)

      const response = {
        action: common.ACTIONS.SCRAPE,
        files: {},
        flags: { min_request_interval: Math.ceil(this.intervalMs / 1000) }
      }

      results.forEach(result => {
        response.files[hex2bin(result.infoHash)] = {
          complete: result.complete || 0,
          incomplete: result.incomplete || 0,
          downloaded: result.complete || 0 // TODO: this only provides a lower-bound
        }
      })

      cb(null, response)
    })
  }
}

Server.Swarm = Swarm

function isObject (obj) {
  return typeof obj === 'object' && obj !== null
}

function toNumber (x) {
  x = Number(x)
  return x >= 0 ? x : false
}

function noop () {}

export default Server
