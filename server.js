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
import Swarm from './server/swarm.js'
import parseWebSocketRequest from './server/parse-websocket.js'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import fs from 'fs'
import path from 'path'
import ed from 'ed25519-supercop'
import url from 'url'

const debug = Debug('bittorrent-tracker:server')
const hasOwnProperty = Object.prototype.hasOwnProperty
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
// const __filename = url.fileURLToPath(import.meta.url)

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
 * @param {Number}  opts.dhtHost      port used for the dht
 * @param {Number}  opts.trackerHost     port used for the tracker
 * @param {String}  opts.host     host used for server
 * @param {Number}  opts.port     port used for server
 * @param {String}  opts.domain     domain name that will be used
 * @param {Boolean}  opts.trustProxy     trust 'x-forwarded-for' header from reverse proxy
 * @param {String}  opts.auth     password to add infohashes
 * @param {String}  opts.dir     directory to store config files
 * @param {Array}  opts.hashes     infohashes to use
 * @param {String}  opts.key    use a public key
 * @param {Boolean|String}  opts.index    serve an html file when the request is to /
 */

// * @param {Function}  opts.extendRelay    have custom capabilities
// * @param {Function}  opts.extendHandler     handle custom routes

class Server extends EventEmitter {
  constructor (opts = {}) {
    super()
    debug('new server %s', JSON.stringify(opts))

    const self = this

    this.index = opts.index
    this.dir = opts.dir || __dirname
    if(this.index){
      if(this.index === true){
        if(!fs.existsSync(path.join(this.dir, 'index.html'))){
          fs.writeFileSync(path.join(this.dir, 'index.html'), '<html><head><title>Relay</title></head><body><h1>Relay</h1><p>Relay</p></body></html>')
        }
      } else {
        const useIndex = this.index
        this.index = true
        try {
          const htmlFile = path.extname(useIndex) === '.html' ? true : false
          if(htmlFile){
            fs.copyFileSync(useIndex, path.join(this.dir, 'index.html'))
          } else {
            fs.writeFileSync(path.join(this.dir, 'index.html'), '<html><head><title>Relay</title></head><body>' + fs.readFileSync(useIndex).toString() + '</body></html>')
          }
        } catch (error) {
          console.error(error)
          if(!fs.existsSync(path.join(this.dir, 'index.html'))){
            fs.writeFileSync(path.join(this.dir, 'index.html'), '<html><head><title>Relay</title></head><body><h1>Relay</h1><p>Relay</p></body></html>')
          }
        }
      }
    } else {
      if(this.index === false){
        if(fs.existsSync(path.join(this.dir, 'index.html'))){
          fs.rmSync(path.join(this.dir, 'index.html'))
        }
      }
    }
    this.auth = opts.auth || null
    this.key = opts.key || null
    if(this.auth){
      bcrypt.hash(opts.auth, 10, function(err, hash) {
        if(err){
          self.emit('error', 'ev', err)
          self.auth = null
          self.emit('ev', 'auth had error, will not be able to change infohahes')
        } else if(hash){
          self.auth = hash
        } else {
          self.emit('error', 'ev', new Error('could not generate hash'))
          self.auth = null
          self.emit('ev', 'did not have error but also did not have auth, will not be able to change infohahes')
        }
      })
    }
    if(this.key){
      this.key = crypto.createHash('sha1').update(this.key).digest('hex')
    } else {
      const test = ed.createSeed()
      const check = ed.createKeyPair(test)
      const useData = {seed: test.toString('hex'), publicKey: check.publicKey.toString('hex'), private: check.secretKey.toString('hex')}
      this.key = crypto.createHash('sha1').update(useData.publicKey).digest('hex')
      self.emit('ev', useData)
    }
    // this.extendRelay = opts.extendRelay ? opts.extendRelay() : null
    // this.extendHandler = opts.extendHandler || null
    
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
    this.domain = opts.domain || null
    this.timer = opts.timer || 1 * 60 * 1000
    this.relayTimer = opts.relayTimer ? opts.relayTimer : 5 * 60 * 1000
    this.DHTPORT = opts.dhtPort || 16881
    this.TRACKERPORT = opts.trackerPort || 16969
    this.DHTHOST = opts.dhtHost || '0.0.0.0'
    this.TRACKERHOST = opts.trackerHost || '0.0.0.0'
    this.host = opts.host
    if(!this.host || this.host === '0.0.0.0'){
      throw new Error('must have host')
    }
    this.port = opts.port || this.TRACKERPORT
    this.hostPort = `${this.host}:${this.port}`
    this.address = crypto.createHash('sha1').update(this.hostPort).digest('hex')
    this.hashes = Array.isArray(opts.hashes) ? opts.hashes : []
    fs.writeFile(path.join(this.dir, 'hashes'), JSON.stringify(this.hashes), {}, (err) => {
      if(err){
        this.emit('error', 'ev', err)
      } else {
        this.emit('ev', 'saved hashes')
      }
    })
    this.relays = this.hashes.map((data) => {return crypto.createHash('sha1').update(data + "'s").digest('hex')})
    fs.writeFile(path.join(this.dir, 'relays'), JSON.stringify(this.relays), {}, (err) => {
      if(err){
        this.emit('error', 'ev', err)
      } else {
        this.emit('ev', 'saved relays')
      }
    })
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
    this.dht = {host: this.DHTHOST, port: this.DHTPORT}
    this.tracker = {host: this.TRACKERHOST, port: this.TRACKERPORT}
    this.id = crypto.createHash('sha1').update(this.host + ':' + this.port).digest('hex')
    this.web = `ws://${this.domain || this.host}:${this.port}`
    this.status = {cpu: 0, memory: 0, state: 1}
    this.trackers = {}
    this.sendTo = {}
    this.triedAlready = {}
    this.hashes.forEach((data) => {this.sendTo[data] = []})

    // start a websocket tracker (for WebTorrent) unless the user explicitly says no
    this.http = http.createServer()
    this.http.onError = (err) => {
      self.emit('error', 'http', err)
    }
    this.http.onListening = () => {
      debug('listening')
      for(const socket in self.trackers){
        if(self.trackers[socket].readyState === 1){
          self.trackers[socket].send(JSON.stringify({action: 'web', tracker: self.tracker, dht: self.dht, domain: self.domain, host: self.host, port: self.port, web: self.web, id: self.id}))
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
  
      if((req.url === '/' || req.url === '/index.html') && req.method === 'GET' && this.index){
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html')
        fs.createReadStream(path.join(this.dir, 'index.html')).pipe(res)
      } else if((req.url === '/stats' || req.url === '/stats.json') && req.method === 'GET'){
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
      } else if(req.method === 'GET' && req.url === '/addresses'){
        const arr = []
        for(const i in self.trackers){
          arr.push(self.trackers[i].address)
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(arr))
      } else if(req.method === 'GET' && req.url === '/ids'){
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(Object.keys(self.trackers)))
      } else if(req.method === 'GET' && req.url === '/hashes'){
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(self.hashes))
      } else if(req.method === 'GET' && req.url === '/keys'){
        const arr = []
        for(const i in self.trackers){
          arr.push(self.trackers[i].key)
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(arr))
      } else if(req.method === 'GET' && req.url === '/zed'){
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify('thanks for using bittorrent-relay'))
      } else if(this.auth && req.method === 'POST' && req.url.startsWith('/add/')){
        let useAuth = ''
        let useRes
        req.onData = function(data){
          useAuth = useAuth + data.toString()
        }
        req.onEnd = function(){
          bcrypt.compare(useAuth, self.auth, (err, data) => {
            if(err){
              res.statusCode = 500
              useRes = err.message
            } else {
              if(data){
                res.statusCode = 200
                const ih = req.url.replace('/add/', '')
                const testHash = crypto.createHash('sha1').update(ih + "'s").digest('hex')
                const doesNotHaveRelay = !self.relays.includes(testHash)
                const doesNotHaveHash = !self.hashes.includes(ih)
                if(doesNotHaveRelay){
                  self.relays.push(testHash)
                  self.relay.lookup(testHash, (err, num) => {
                    if(err){
                      self.emit('error', 'ev', err)
                    } else {
                      self.emit('ev', num)
                    }
                  })
                }
                if(doesNotHaveHash){
                  self.hashes.push(ih)
                  self.relay.announce(ih, self.TRACKERPORT, (err) => {
                    if(err){
                      self.emit('error', 'ev', err)
                    } else {
                      self.emit('ev', 'announced ' + ih)
                    }
                  })
                  self.sendTo[ih] = []
                }
                if(doesNotHaveRelay || doesNotHaveHash){
                  fs.writeFile(path.join(self.dir, 'hashes'), JSON.stringify(self.hashes), {}, (err) => {
                    if(err){
                      self.emit('error', 'ev', err)
                    } else {
                      self.emit('ev', 'saved hashes')
                    }
                  })
                  fs.writeFile(path.join(self.dir, 'relays'), JSON.stringify(self.relays), {}, (err) => {
                    if(err){
                      self.emit('error', 'ev', err)
                    } else {
                      self.emit('ev', 'saved relays')
                    }
                  })
                  for(const testObj of self.trackers){
                    self.trackers[testObj].send(JSON.stringify({action: 'add', relay: testHash, hash: ih}))
                  }
                }
                useRes = 'successful'
              } else {
                res.statusCode = 400
                useRes = 'unsuccessful'
              }
            }
          })
        }
        req.onError = function(err){
          res.statusCode = 400
          useRes = err.message
          req.destroy()
        }
        req.onClose = function(){
          req.off('data', req.onData)
          req.off('end', req.onEnd)
          req.off('error', req.onError)
          req.off('close', req.onClose)
          res.end(useRes)
        }
        req.on('data', req.onData)
        req.on('end', req.onEnd)
        req.on('error', req.onError)
        req.on('close', req.onClose)
      } else if(this.auth && req.method === 'POST' && req.url.startsWith('/sub/')){
        let useAuth = ''
        let useRes
        req.onData = function(data){
          useAuth = useAuth + data.toString()
        }
        req.onError = function(err){
          res.statusCode = 400
          useRes = err.message
          req.destroy()
        }
        req.onEnd = function(){
          bcrypt.compare(useAuth, self.auth, (err, data) => {
            if(err){
              res.statusCode = 500
              useRes = err.message
            } else {
              if(data){
                res.statusCode = 200
                const ih = req.url.replace('/sub/', '')
                const testHash = crypto.createHash('sha1').update(ih + "'s").digest('hex')
                const hasRelay = self.relays.includes(testHash)
                const hasHash = self.hashes.includes(ih)
                if(hasRelay){
                  self.relay.splice(self.relays.indexOf(testHash), 1)
                }
                if(hasHash){
                  self.hashes.splice(self.hashes.indexOf(ih), 1)
                  delete self.sendTo[ih]
                }
                if(hasRelay || hasHash){
                  fs.writeFile(path.join(self.dir, 'hashes'), JSON.stringify(self.hashes), {}, (err) => {
                    if(err){
                      self.emit('error', 'ev', err)
                    } else {
                      self.emit('ev', 'saved hashes')
                    }
                  })
                  fs.writeFile(path.join(self.dir, 'relays'), JSON.stringify(self.relays), {}, (err) => {
                    if(err){
                      self.emit('error', 'ev', err)
                    } else {
                      self.emit('ev', 'saved relays')
                    }
                  })
                  for(const testObj of self.trackers){
                    if(self.trackers[testObj].relays.includes(testHash)){
                      self.trackers[testObj].relays.splice(self.trackers[testObj].relays.indexOf(testHash), 1)
                    }
                    if(self.trackers[testObj].hashes.includes(ih)){
                      self.trackers[testObj].hashes.splice(self.trackers[testObj].hashes.indexOf(ih), 1)
                    }
                    self.trackers[testObj].send(JSON.stringify({action: 'sub', relay: testHash, hash: ih}))
                    if(!self.trackers[testObj].relays.length || !self.trackers[testObj].hashes.length){
                      self.trackers[testObj].terminate()
                    }
                  }
                }
                useRes = 'successful'
              } else {
                res.statusCode = 400
                useRes = 'unsuccessful'
              }
            }
          })
        }
        req.onClose = function(){
          req.off('data', req.onData)
          req.off('error', req.onError)
          req.off('end', req.onEnd)
          req.off('close', req.onClose)
          res.end(useRes)
        }
        req.on('data', req.onData)
        req.on('error', req.onError)
        req.on('end', req.onEnd)
        req.on('close', req.onClose)
      } else {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify('invalid method or path'))
      }
      // if(this.extendHandler){
      //   try {
      //     this.extendHandler(req, this.extendRelay, res)
      //   } catch (error) {
      //     res.statusCode = 400
      //     res.setHeader('Content-Type', 'application/json')
      //     res.end(JSON.stringify(error.message))
      //   }
      // }
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
            socket.send(JSON.stringify({action: 'relay', relay: self.sendTo[hash][Math.floor(Math.random() * self.sendTo[hash].length)]}))
            socket.terminate()
          } else {
            socket.upgradeReq = req
            self.onWebSocketConnection(socket)
          }

        } else if(action === 'relay'){

          if(this.triedAlready[hash]){
            delete this.triedAlready[hash]
          }
          if(self.trackers[hash]){
            socket.terminate()
          } else {
            socket.id = hash
            socket.server = true
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
    this.ws.onListening = () => {
      self.ws.listening = true
      self.emit('listening', 'ws')
    }
    this.ws.onClose = () => {
      self.ws.listening = false
      self.emit('close', 'ws')
    }
    this.ws.on('listening', this.ws.onListening)
    this.ws.on('close', this.ws.onClose)
    this.ws.on('error', this.ws.onError)
    this.ws.on('connection', this.ws.onConnection)

    // this.intervalUsage(60000)

    this.relay = new DHT()
    this.relay.onListening = () => {
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

      const id = crypto.createHash('sha1').update(peer.host + ':' + peer.port).digest('hex')
      if(self.trackers[id] || self.id === id){
        return
      }

      if(this.auth && !this.relays.includes(infoHash)){
        return
      }

      if(this.triedAlready[id]){
        const checkStamp =  (Date.now() - this.triedAlready[id].stamp) / 1000
        if(this.triedAlready[id].wait >= checkStamp){
          return
        }
      }

      const relay = `ws://${peer.host}:${peer.port}/relay/`
      const con = new WebSocket(relay + self.id)
      con.server = false
      con.active = true
      con.relays = [infoHash]
      con.hashes = []
      con.id = id
      self.onRelaySocketConnection(con)
    })

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
        if(err){
          this.emit('error', 'ev', err)
        } else {
          this.emit('ev', num)
        }
      })
      this.relay.announce(test, this.TRACKERPORT, (err) => {
        if(err){
          this.emit('error', 'ev', err)
        } else {
          this.emit('ev', 'announced ' + test)
        }
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
    socket.onOpen = function(){
      // self.trackers[socket.id] = socket
      if(self.triedAlready[socket.id]){
        delete self.triedAlready[socket.id]
      }
      socket.send(JSON.stringify({id: self.id, key: self.key, address: self.address, hostPort: self.hostPort, tracker: self.tracker, web: self.web, host: self.host, port: self.port, dht: self.dht, domain: self.domain, relays: self.relays, hashes: self.hashes, action: 'session'}))
    }
    socket.onError = function(err){
      if(self.triedAlready[socket.id]){
        self.triedAlready[socket.id].stamp = Date.now()
        self.triedAlready[socket.id].wait = self.triedAlready[socket.id].wait * 2
      } else {
        self.triedAlready[socket.id] = {stamp: Date.now(), wait: 1}
      }
      self.emit('ev', socket.id + ' had an error, will wait and try to connect later')
      self.emit('error', 'ws', err)
      socket.terminate()
    }
    socket.onMessage = function(data, buffer){
      const message = buffer ? JSON.parse(Buffer.from(data).toString('utf-8')) : JSON.parse(data)
      if(message.action === 'session'){
        if(socket.id !== message.id){
          socket.terminate()
          return
        }
        self.trackers[socket.id] = socket
        socket.id = message.id
        socket.key = message.key
        socket.domain = message.domain
        socket.tracker = message.tracker
        socket.port = message.port
        socket.host = message.host
        socket.web = message.web
        socket.dht = message.dht
        socket.address = message.address
        socket.hostPort = message.hostPort
        socket.relay = message.web + '/relay'
        socket.announce = message.web + '/announce'
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
        if(!socket.relays.length || !socket.hashes.length){
          socket.terminate()
          return
        }
        if(socket.server){
          socket.send(JSON.stringify({id: self.id, key: self.key, address: self.address, hostPort: self.hostPort, tracker: self.tracker, web: self.web, host: self.host, port: self.port, dht: self.dht, domain: self.domain, relays: self.relays, hashes: self.hashes, action: 'session'}))
        }
      }
      if(message.action === 'web'){
        if(socket.domain !== message.domain){
          socket.domain = message.domain
        }
        if(socket.tracker.host !== message.tracker.host || socket.tracker.port !== message.tracker.port){
          socket.tracker = message.tracker
        }
        if(socket.dht.host !== message.dht.host || socket.dht.port !== message.dht.port){
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
      }
      if(message.action === 'add'){
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
      if(message.action === 'sub'){
        if(socket.relays.includes(message.relay)){
          socket.relays.splice(socket.relays.indexOf(message.relay), 1)
        }
        if(socket.hashes.includes(message.hash)){
          socket.hashes.splice(socket.hashes.indexOf(message.hash), 1)
        }
        const useLink = socket.announce + '/' + message.hash
        if(self.sendTo[message.hash].includes(useLink)){
          self.sendTo[message.hash].splice(self.sendTo[message.hash].indexOf(useLink), 1)
        }
        if(!socket.relays.length || !socket.hashes.length){
          socket.terminate()
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
      socket.off('open', socket.onOpen)
      socket.off('error', socket.onError)
      socket.off('message', socket.onMessage)
      socket.off('close', socket.onClose)

      for(const testHash of socket.hashes){
        const useLink = socket.announce + '/' + testHash
        if(self.sendTo[testHash].includes(useLink)){
          self.sendTo[testHash].splice(self.sendTo[testHash].indexOf(useLink), 1)
        }
      }

      delete self.trackers[socket.id]
      self.emit('ev', {code, reason: reason.toString()})
    }
    socket.on('open', socket.onOpen)
    socket.on('error', socket.onError)
    socket.on('message', socket.onMessage)
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
            info_hash: hex2bin(params.info_hash),
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
            info_hash: hex2bin(params.info_hash),
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

function noop () {}

export default Server
