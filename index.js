import Debug from 'debug'
import EventEmitter from 'events'
import http from 'http'
import peerid from 'bittorrent-peerid'
import series from 'run-series'
import string2compact from 'string2compact'
import { WebSocketServer, WebSocket } from 'ws'
import DHT from 'bittorrent-dht'
import {createProxyMiddleware} from 'http-proxy-middleware'
import { hex2bin } from 'uint8-util'
import pidusage from 'pidusage'
import common from './lib/common.js'
import Swarm from './lib/swarm.js'
import parseWebSocketRequest from './lib/parse-websocket.js'

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
 * @param {Number}  opts.dhtPort      port used for the dht
 * @param {Number}  opts.trackerPort     port used for the tracker
 * @param {String}  opts.dhtHost     host used for the dht
 * @param {String}  opts.trackerHost     host used for the tracker
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
    this.timer = opts.relayTimer ? opts.relayTimer : 15 * 60 * 1000
    this.DHTPORT = opts.dhtPort || 16881
    this.TRACKERPORT = opts.trackerPort || 16969
    this.DHTHOST = opts.dhtHost || '0.0.0.0'
    this.TRACKERHOST = opts.trackerHost || '0.0.0.0'
    this.hashes = (() => {if(!opts.hashes){return [];}return Array.isArray(opts.hashes) ? opts.hashes : opts.hashes.split(',');})()
    this.relays = this.hashes.map((data) => {return crypto.createHash('sha1').update(data + "'s").digest('hex')})
    this.userHashes = this.hashes.length ? true : false
    // this._trustProxy = !!opts.trustProxy
    this._trustProxy = opts.trustProxy === false ? opts.trustProxy : true
    // if (typeof opts.filter === 'function') this._filter = opts.filter
    this._filter = function (infoHash, params, cb) {
      // const hashes = (() => {if(!opts.hashes){throw new Error('must have hashes')}return Array.isArray(opts.hashes) ? opts.hashes : opts.hashes.split(',')})()
      if(this.userHashes){
        if(this.hashes.includes(infoHash)){
          cb(null)
        } else {
          cb(new Error('disallowed torrent'))
        }
      } else {
        if(this.hashes.includes(infoHash)){
          cb(null)
        } else {
          this.hashes.push(infoHash)
          const testHash = crypto.createHash('sha1').update(infoHash + "'s").digest('hex')
          this.relays.push(testHash)
          this.dht.lookup(testHash, (err, num) => {
            console.log(err, num)
          })
          this.dht.announce(testHash, this.TRACKERPORT, (err) => {
              console.log(err)
          })
          cb(null)
        }
      }
    }
    this.status = {cpu: 0, mem: 0, state: null}

    // start a websocket tracker (for WebTorrent) unless the user explicitly says no
    const self = this
    this.http = http.createServer()
    this.http.onError = (err) => {
      self.emit('http-error', err)
    }
    this.http.onListening = () => {
      debug('listening')
      self.emit('http-listening')
    }
    this.http.onRequest = (req, res) => {
      if (res.headersSent) return

      const infoHashes = Object.keys(this.torrents)
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
          const peers = this.torrents[infoHash].peers
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
      } else {
        throw new Error(`invalid action in HTTP request: ${req.url}`)
      }
    }
    this.http.onClose = () => {
      self.emit('http-close')
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
      noServer: true
    })
    this.ws.onError = (err) => {
      self.emit('ws-error', err)
    }
    this.ws.onConnection = (socket, req) => {
      // Note: socket.upgradeReq was removed in ws@3.0.0, so re-add it.
      // https://github.com/websockets/ws/pull/1099

      // if resource usage is high, send only the url of another tracker
      // else handle websockets as usual
      socket.upgradeReq = req
      this.onWebSocketConnection(socket)
    }
    this.ws.onClose = () => {
      self.emit('ws-close')
    }
    this.ws.onListening = () => {
      self.emit('ws-listening')
    }
    this.ws.on('listening', this.ws.onListening)
    this.ws.on('close', this.ws.onClose)
    this.ws.on('error', this.ws.onError)
    this.ws.on('connection', this.ws.onConnection)
    this.ws.address = () => {
      if(this.http.listening){
        return this.http.address()
      } else {
        return null
      }
    }

    this.http.onUpgrade = (request, socket, head) => {
      // connect if relay tracker
      // if client then go through resource
    }
    this.http.on('upgrade', this.http.onUpgrade)

    this.intervalUsage(60000)

    this.dht = new DHT()
    this.dht.onListening = () => {
      self.emit('listening')
    }
    this.dht.onReady = () => {
      self.emit('ready')
    }
    this.dht.onError = (err) => {
      self.emit('error', err)
    }
    this.dht.on('ready', this.dht.onReady)
    this.dht.on('listening', this.dht.onListening)
    this.dht.on('error', this.dht.onError)
    this.dht.listen(this.DHTPORT, this.DHTHOST)

    this.trackers = new Map()
    
    this.dht.on('peer', (peer, infoHash, from) => {
    // if not connected, then connect socket
    // share resource details on websocket
    })
    this.dht.on('announce', (peer, infoHash) => {
    // if not connected, then connect socket
    // share resource details on websocket
    })

    this.talkToRelay()

    this.intervalRelay = setInterval(() => {
      this.talkToRelay()
  }, this.relayTimer)
  }

  talkToRelay(){
    for(const test of this.relays){
      this.dht.lookup(test, (err, num) => {
          console.log(err, num)
      })
      this.dht.announce(test, this.TRACKERPORT, (err) => {
          console.log(err)
      })
    }
  }

  compute(cb) {
    const self = this
    pidusage(process.pid, function (err, stats) {
      if(err){
        console.error(err)
      } else if(stats){
        if(stats.cpu > 95 || stats.mem > 1615000000){
          if(self.status.cpu < stats.cpu || self.status.mem < stats.memory){
            self.http.off('error', self.http.onError)
            self.http.off('listening', self.http.onListening)
            self.http.off('request', self.http.handleRequest)
            self.http.off('upgrade', self.http.handleUpgrade)
            self.http.close((err) => {
              console.error(err)
            })
          }
          self.status = {cpu: stats.cpu, mem: stats.memory, state: 3}
        } // send url of another tracker before closing server, if no tracker is available then close server
        else if((stats.cpu > 75 && stats.cpu < 95) || (stats.mem > 1275000000 && stats.mem < 1615000000)){
          if(self.status.cpu > 95 || self.status.mem > 1615000000){
            self.http.on('error', self.http.onError)
            self.http.on('listening', self.http.onListening)
            self.http.on('request', self.http.handleRequest)
            self.http.on('upgrade', self.http.handleUpgrade)
            self.http.listen(self.TRACKERPORT, self.TRACKERHOST, undefined)
          }
          self.status = {cpu: stats.cpu, mem: stats.memory, state: 2}
        } else {
          if(self.status.cpu > 95 || self.status.mem > 1615000000){
            self.http.on('error', self.http.onError)
            self.http.on('listening', self.http.onListening)
            self.http.on('request', self.http.handleRequest)
            self.http.on('upgrade', self.http.handleUpgrade)
            self.http.listen(self.TRACKERPORT, self.TRACKERHOST, undefined)
          }
          self.status = {cpu: stats.cpu, mem: stats.memory, state: 1}
        }
      } else {
        console.error('no error, no stats')
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
    setTimeout(function() {
      self.compute(function() {
        self.intervalUsage(time)
      })
    }, time)
  }

  listen (){
    if(this.http.listening){
      throw new Error('server already listening')
      // return
    } else {
      this.http.listen(this.TRACKERPORT, this.TRACKERHOST, undefined)
    }
  }

  close () {
    debug('close')

    // try {
    //   this.ws.close((err) => {
    //     console.error(err)
    //   })
    // } catch (err) {
    //   console.error(err)
    // }
    if(!this.http.listening){
      throw new Error('server is not listening')
    }
    const self = this
    try {
      this.http.close((err) => {
        self.emit('error', err)
      })
    } catch (error) {
      this.emit('error', error)
    }

    // this.destroyed = true
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
