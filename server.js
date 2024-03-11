import Debug from 'debug'
import EventEmitter from 'events'
import http from 'http'
import peerid from 'bittorrent-peerid'
import series from 'run-series'
import string2compact from 'string2compact'
import { WebSocketServer, WebSocket } from 'ws'
import DHT from 'bittorrent-dht'
import { hex2bin } from 'uint8-util'
import common from './lib/common.js'
import Swarm from './server/swarm.js'
import parseHttpRequest from './server/parse-http.js'
import parseWebSocketRequest from './server/parse-websocket.js'
import crypto from 'crypto'
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
 * @param {Object}  opts.timer       interval for general things like checking for active and inactive connections (ms)
 * @param {Number}  opts.dhtPort      port used for the dht
 * @param {Number}  opts.trackerPort     port used for the tracker
 * @param {Number}  opts.dhtHost      port used for the dht
 * @param {Number}  opts.trackerHost     port used for the tracker
 * @param {String}  opts.host     host used for server
 * @param {Number}  opts.port     port used for server
 * @param {String}  opts.domain     domain name that will be used
 * @param {Boolean}  opts.trustProxy     trust 'x-forwarded-for' header from reverse proxy
 * @param {Boolean}  opts.auth     password to add infohashes
 * @param {String}  opts.dir     directory to store config files
 * @param {Array|String}  opts.hashes     join the relays for these hashes, array of hashes or comma separated string of hashes
 * @param {Object|Boolean}  opts.user    user data like public key and private key
 * @param {Boolean} opts.stats          enable web-based statistics?
 * @param {Object} opts.limit       limit the connections of the relay and the hashes
 * @param {Boolean} opts.tracks      enable routes to share internal data to users
 * @param {Boolean} opts.status          accept only the hashes from the hashes array in the hashes option
 * @param {Boolean|String}  opts.index    serve an html file when the request is to /
 * @param {Boolean|String}  opts.peersCacheLength    max amount of elements in cache, default is 1000
 * @param {Boolean|String}  opts.peersCacheTtl    max amount of time to hold elements in cache, default is 20 minutes
 * @param {Boolean|String}  opts.init    automatically start once instantiated
 */

// * @param {Function}  opts.extendRelay    have custom capabilities
// * @param {Function}  opts.extendHandler     handle custom routes
// * @param {Number}  opts.relayTimer       interval to find and connect to other trackers (ms)

class Server extends EventEmitter {
  constructor (opts = {}) {
    super()
    debug('new server %s', JSON.stringify(opts))

    const self = this
    
    this.test = '0'
    this.stats = opts.stats
    this.tracks = opts.tracks
    this.limit = typeof(opts.limit) === 'object' && !Array.isArray(opts.limit) ? opts.limit : {}
    this.timer = typeof(opts.timer) === 'object' && !Array.isArray(opts.timer) ? opts.timer : {}
    this.limit.serverConnections = this.limit.serverConnections || 0
    this.limit.clientConnections = this.limit.clientConnections || 0
    this.limit.refreshConnections = this.limit.clientConnections ? this.limit.clientConnections + (this.limit.refresh ? this.limit.refreshConnections || 1000 : 1000) : 0
    this.limit.refreshLimit = this.limit.refreshLimit || 0
    this.limit.clientOrRefresh = Boolean(this.limit.clientOrRefresh)
    this.timer.activity = this.timer.activity || 5 * 60 * 1000
    this.clientCount = 0
    this.serverCount = 0
    this.listening = false
    this.timer.interval = this.timer.interval ? this.timer.interval : 10 * 60 * 1000
    this.peersCacheLength = opts.peersCacheLength
    this.peersCacheTtl = opts.peersCacheTtl
    this.destroyed = false
    this.torrents = {}
    this.http = null
    this.ws = null
    this.domain = opts.domain || null
    this.timer.inactive = this.timer.inactive || 1 * 60 * 1000
    this.timer.active = this.timer.active || 5 * 60 * 1000
    this.DHTPORT = opts.dhtPort || 16881
    this.TRACKERPORT = opts.trackerPort || 16969
    this.DHTHOST = opts.dhtHost || '0.0.0.0'
    this.TRACKERHOST = opts.trackerHost || '0.0.0.0'
    this.host = opts.host
    if(!this.host || this.host.includes('0.0.0.0') || this.host.includes('localhost') || this.host.includes('127.0.0.1')){
      throw new Error('must have host')
    }
    this.port = opts.port || this.TRACKERPORT
    this.address = `${this.host}:${this.port}`
    this._trustProxy = Boolean(opts.trustProxy)
    this.dht = {host: this.DHTHOST, port: this.DHTPORT}
    this.tracker = {host: this.TRACKERHOST, port: this.TRACKERPORT}
    this.hash = crypto.createHash('sha1').update(this.address).digest('hex')
    this.web = {http: `http://${this.domain || this.host}:${this.port}`, ws: `ws://${this.domain || this.host}:${this.port}`}
    this.trackers = new Map()
    this.triedAlready = new Map()
    this.status = Boolean(opts.status)

    if(opts.dir){
      if(!fs.existsSync(opts.dir)){
        fs.mkdirSync(opts.dir)
      }
    }
    this.dir = path.join(opts.dir || __dirname, 'dir')
    if(!fs.existsSync(this.dir)){
      fs.mkdirSync(this.dir)
    }
    
    this.index = Boolean(opts.index)
    if(this.index === true){
      if(!fs.existsSync(path.join(this.dir, 'index.html'))){
        fs.writeFileSync(path.join(this.dir, 'index.html'), '<html><head><title>Relay</title></head><body><h1>Relay</h1><p>Relay</p></body></html>')
      }
    }

    this.auth = opts.auth || null
    this.user = opts.user || {}
    if(!fs.existsSync(path.join(this.dir, 'user'))){
      fs.mkdirSync(path.join(this.dir, 'user'))
    }
    try {
      this.sig = ed.sign(this.test, this.user.pub, this.user.priv)
      this.key = this.user.pub
      this.emit('ev', 'signed data using key')
    } catch (error) {
      this.emit('ev', 'key generation error: ' + error.message)
      const useCheck = this.genKey()
      this.sig = useCheck.sig
      this.key = useCheck.pub
      this.emit('ev', 'new key data was created, check ' + path.join(this.dir, 'user') + ' for new key data, temp.txt will be deleted in 5 minutes')
    }

    this.hashes = new Set((typeof(opts.hashes) === 'object' && Array.isArray(opts.hashes)) ? opts.hashes : typeof(opts.hashes) === 'string' ? opts.hashes.split(',').filter(Boolean) : [])
    fs.writeFile(path.join(this.dir, 'hashes.txt'), JSON.stringify(Array.from(this.hashes)), {}, (err) => {
      if(err){
        this.emit('error', err)
      } else {
        this.emit('ev', 'saved relays')
      }
    })
    this.relays = new Map((() => {const test = [];this.hashes.forEach((data) => {test.push([crypto.createHash('sha1').update(data).digest('hex'), []])});return test;})())
    fs.writeFile(path.join(this.dir, 'relays.txt'), JSON.stringify(Array.from(this.relays.keys())), {}, (err) => {
      if(err){
        this.emit('error', err)
      } else {
        this.emit('ev', 'saved relays')
      }
    })
    
    this.http = http.createServer()
    this.http.onError = (err) => {
      self.emit('error', err)
    }
    this.http.onListening = () => {
      debug('listening')
      // for(const socket in self.trackers.values()){
      //   if(socket.readyState === 1){
      //     socket.send(JSON.stringify({action: 'web', tracker: self.tracker, dht: self.dht, domain: self.domain, host: self.host, port: self.port, web: self.web, hash: self.hash}))
      //   }
      // }
      self.trackers.forEach((data) => {data.send(JSON.stringify({action: 'on'}))})
      if(self.limit.refreshConnections){
        if(self.refresh){
          clearInterval(self.refresh)
        }
        self.refresh = setInterval(() => {
          if(self.limit.refreshConnections){
            if(self.clientCount >= self.limit.refreshConnections){
              self.turnOffHTTP()
            }
          }
        }, this.timer.activity)
      }

      self.talkToRelay()
      this.listening = true
      self.emit('listening', 'http')
    }
    this.http.onRequest = (req, res) => {
      // if (res.headersSent) return
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

      try {
        if(req.url.startsWith('/announce/')){
          const useInfoHash = req.url.slice(0, req.url.indexOf('?')).replace('/announce/', '')
          if(!this.hashes.has(useInfoHash)){
            return res.end(bencode.encode({'failure reason': 'infohash is not supported'}))
          }
          // const useQueryString = req.url.replace('/announce/', '').slice(0, req.url.indexOf('?'))
          // if(!this.hashes.has(useQueryString)){}
          return this.onHttpRequest(req, res)
        } else if(req.url.startsWith('/relay/')){
          const useRelayHash = req.url.slice(0, req.url.indexOf('?')).replace('/relay/', '')
          const para = new URLSearchParams(req.url.slice(req.url.indexOf('?')))
          if(!this.relays.has(useRelayHash)){
            return res.end(bencode.encode({'failure reason': 'relayhash is not supported'}))
          }
          let size
          if(para.has('size')){
            if(JSON.parse(para.get('size'))){
              size = this.limit.serverConnections
            }
          }
          let keys
          if(para.has('keys')){
            if(JSON.parse(para.get('keys'))){
              keys = this.relays.get(useRelayHash).map((data) => {return data.key})
            }
          }
          // const rh = req.url.replace('/relay/', '').replace(para, '')
          // const useQueryString = req.url.replace('/relay/', '').slice(0, req.url.indexOf('?'))
          // if(!this.relays.has(useQueryString)){}
          res.setHeader('Content-Type', 'text/plain; charset=UTF-8')
          return res.end(bencode.encode({size, keys}))
        } else if(req.method === 'HEAD' && req.url === '/'){
          res.statusCode = 200
          res.end()
        } else if(req.method === 'GET' && req.url === '/'){
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/plain')
          res.end('thanks for testing bittorrent-relay')
        } else if(req.method === 'GET' && req.url === '/index.html' && this.index){
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html')
          let useText = ''
          // fs.createReadStream(path.join(this.dir, 'index.html')).pipe(res)
          const useStream = fs.createReadStream(path.join(this.dir, 'index.html'))
          function useError(e){
            useOff()
            res.end(`<html><head><title>${e.name}</title></head><body>${e.message}</body></html>`)
          }
          function useClose(){
            useOff()
            res.end(useText)
          }
          function useData(c){
            useText = useText + c.toString('utf-8')
          }
          function useOff(){
            useStream.off('error', useError)
            useStream.off('data', useData)
            useStream.off('close', useClose)
          }
          useStream.on('error', useError)
          useStream.on('data', useData)
          useStream.on('close', useClose)
        } else if(req.method === 'GET' && req.url === '/stats.html' && this.stats){
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
  
        } else if(req.method === 'GET' && req.url === '/hashes.html' && this.tracks){
          res.setHeader('Content-Type', 'text/html')
          res.end(`<html><head><title>Relay</title></head><body>${(() => {const arr = [];for(const testing of this.hashes.keys()){arr.push(testing)};return arr;})().join('\n')}</body></html>`)
        } else if(req.method === 'GET' && req.url === '/hashes.json' && this.tracks){
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(Array.from(this.hashes)))
        } else if(req.method === 'POST' && req.url.startsWith('/add/') && this.auth){
          let useAuth = ''
          let useRes
          function onData(data){
            useAuth = useAuth + data.toString()
          }
          function onEnd(){
            const sign = ed.sign(this.test, self.user.pub, useAuth)
            if(!ed.verify(sign, this.test, self.key) || self.sig !== sign.toString('hex')){
              res.statusCode = 400
              useRes = 'unsuccessful'
            } else {
              const ih = req.url.replace('/add/', '')
              const testHash = crypto.createHash('sha1').update(ih).digest('hex')
              const checkHash = self.hashes.has(ih)
              const checkRelay = self.relays.has(testHash)
              const check = checkHash && checkRelay
              if(check){
                res.statusCode = 400
                useRes = 'already exists'
              } else {
                res.statusCode = 200
                if(!checkHash){
                  self.hashes.add(ih)
                }
                if(!checkRelay){
                  self.relays.set(testHash, [])
                }
                self.relay.lookup(testHash, (err, num) => {
                  if(err){
                    self.emit('error', err)
                  } else {
                    self.emit('ev', num)
                  }
                })
                self.relay.announce(testHash, self.TRACKERPORT, (err) => {
                  if(err){
                    self.emit('error', err)
                  } else {
                    self.emit('ev', 'announced ' + ih)
                  }
                })
                fs.writeFile(path.join(self.dir, 'hashes.txt'), JSON.stringify(Array.from(self.hashes)), {}, (err) => {
                  if(err){
                    self.emit('error', err)
                  } else {
                    self.emit('ev', 'saved relays')
                  }
                })
                fs.writeFile(path.join(self.dir, 'relays.txt'), JSON.stringify(Array.from(self.relays.keys())), {}, (err) => {
                  if(err){
                    self.emit('error', err)
                  } else {
                    self.emit('ev', 'saved relays')
                  }
                })
                useRes = 'successful'
              }
            }
          }
          function onError(err){
            // useOff()
            res.statusCode = 400
            useRes = err.message
            req.destroy()
            // res.end(err.message)
          }
          function onClose(){
            useOff()
            res.end(useRes)
          }
          function useOff(){
            req.off('data', onData)
            req.off('end', onEnd)
            req.off('error', onError)
            req.off('close', onClose)
          }
          req.on('data', onData)
          req.on('end', onEnd)
          req.on('error', onError)
          req.on('close', onClose)
        } else if(req.method === 'POST' && req.url.startsWith('/sub/') && this.auth){
          let useAuth = ''
          let useRes
          function onData(data){
            useAuth = useAuth + data.toString()
          }
          function onError(err){
            // useOff()
            res.statusCode = 400
            useRes = err.message
            req.destroy()
            // res.end(err.message)
          }
          function onEnd(){
            const sign = ed.sign(this.test, self.key, useAuth)
            if(!ed.verify(sign, this.test, self.key) || self.sig !== sign.toString('hex')){
              res.statusCode = 400
              useRes = 'unsuccessful'
            } else {
              const ih = req.url.replace('/sub/', '')
              const testHash = crypto.createHash('sha1').update(ih).digest('hex')
              const checkHash = self.hashes.has(ih)
              const checkRelay = self.relays.has(testHash)
              const check = checkHash && checkRelay
              if(check){
                res.statusCode = 200
                if(checkHash){
                  self.hashes.delete(ih)
                }
                if(checkRelay){
                  self.relays.get(testHash).forEach((data) => {
                    data.send(JSON.stringify({action: 'sub', relay: testHash, reply: false}))
                    data.close()
                    // data.terminate()
                  })
                  self.relays.delete(testHash)
                }
                fs.writeFile(path.join(self.dir, 'hashes.txt'), JSON.stringify(Array.from(self.hashes)), {}, (err) => {
                  if(err){
                    self.emit('error', err)
                  } else {
                    self.emit('ev', 'saved relays')
                  }
                })
                fs.writeFile(path.join(self.dir, 'relays.txt'), JSON.stringify(Array.from(self.relays.keys())), {}, (err) => {
                  if(err){
                    self.emit('error', err)
                  } else {
                    self.emit('ev', 'saved relays')
                  }
                })
                useRes = 'successful'
              } else {
                res.statusCode = 400
                useRes = 'already does not exist'
              }
            }
          }
          function onClose(){
            useOff()
            res.end(useRes)
          }
          function useOff(){
            req.off('data', onData)
            req.off('error', onError)
            req.off('end', onEnd)
            req.off('close', onClose)
          }
          req.on('data', onData)
          req.on('error', onError)
          req.on('end', onEnd)
          req.on('close', onClose)
        } else {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify('invalid method or path'))
        }
      } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(error.message))
      }
    }
    this.http.onClose = () => {
      this.http.handleListeners()
      // this.ws.clients.forEach((data) => {
      //   data.send(JSON.stringify({action: 'off'}))
      //   data.terminate()
      // })
      self.trackers.forEach((data) => {
        data.send(JSON.stringify({action: 'off'}))
      })
      this.triedAlready.clear()

      if(self.limit.refreshConnections){
        if(self.refresh){
          clearInterval(self.refresh)
        }
        self.refresh = setInterval(() => {
          const check = self.limit.clientOrRefresh ? self.limit.refreshConnections : self.limit.clientConnections
          if(self.clientCount <= check){
            if(self.limit.refreshLimit){
              if(self.clientCount <= self.limit.refreshLimit){
                self.turnWeb()
                self.turnOnHTTP()
              }
            } else {
              self.turnWeb()
              self.turnOnHTTP()
            }
          }
        }, this.timer.activity)
      }

      this.listening = false
      self.emit('close', 'http')
    }
    this.http.handleListeners = () => {
      this.http.off('error', this.http.onError)
      this.http.off('listening', this.http.onListening)
      this.http.off('request', this.http.onRequest)
      this.http.off('close', this.http.onClose)
    }

    // Add default http request handler on next tick to give user the chance to add
    // their own handler first. Handle requests untouched by user's handler.
    this.ws = new WebSocketServer({
      ...(typeof(opts.ws) === 'object' && !Array.isArray(opts.ws) ? opts.ws : {}),
      perMessageDeflate: false,
      clientTracking: false,
      server: this.http
    })
    this.ws.onError = (err) => {
      self.emit('error', err)
    }
    this.ws.onConnection = (socket, req) => {
      // Note: socket.upgradeReq was removed in ws@3.0.0, so re-add it.
      // https://github.com/websockets/ws/pull/1099

      // if resource usage is high, send only the url of another tracker
      // else handle websockets as usual
      if(req.url.startsWith('/announce/')){
        const useTest = req.url.replace('/announce/', '')
        // const useTest = crypto.createHash('sha1').update(req.url.slice(req.url.lastIndexOf('/')).slice(1)).digest('hex')
        if(!this.hashes.has(useTest)){
          socket.send(JSON.stringify({action: 'failure reason', error: 'infohash is not supported'}))
          socket.close()
          return
        }
        socket.upgradeReq = req
        self.onWebSocketConnection(socket)
      } else if(req.url.startsWith('/relay/')){
        // have id and relay in the url routes
        // have different functions to handle connections and extras
        const useTest = req.url.replace('/relay/', '')
        // const useTest = crypto.createHash('sha1').update(req.url.slice(req.url.lastIndexOf('/')).slice(1)).digest('hex')
        if(!this.relays.has(useTest)){
          socket.send(JSON.stringify({action: 'failure reason', error: 'relay is not supported'}))
          socket.close()
          return
        }
        if(this.limit.serverConnections){
          if(this.relays.get(useTest).length < this.limit.serverConnections){
            socket.hash = null
            socket.server = true
            socket.active = true
            socket.proc = false
            // socket.relay = useTest
            this.onRelaySocketConnection(socket)
          }
        } else {
          socket.hash = null
          socket.server = true
          socket.active = true
          socket.proc = false
          // socket.relay = useTest
          this.onRelaySocketConnection(socket)
        }
      } else {
        socket.send(JSON.stringify({action: 'failure reason', error: 'route is not supported'}))
        socket.close()
        return
      }
    }
    this.ws.onListening = () => {
      self.emit('listening', 'ws')
    }
    this.ws.onClose = () => {
      self.emit('close', 'ws')
    }

    // this.intervalUsage(60000)

    this.relay = new DHT()
    this.relay.onListening = () => {
      self.emit('listening', 'relay')
    }
    this.relay.onReady = () => {
      self.emit('ready', 'relay')
    }
    this.relay.onError = (err) => {
      self.emit('error', err)
    }
    this.relay.onClose = () => {
      self.emit('close', 'relay')
    }
    this.relay.onPeer = (peer, infoHash, from) => {
      // if not connected, then connect socket
      // share resource details on websocket
      // this.tracker[infoHash][ws-link]
      const ih = infoHash.toString('hex')

      if(!this.relays.has(ih)){
        return
      }

      const hash = crypto.createHash('sha1').update(peer.host + ':' + peer.port).digest('hex')
      if(self.hash === hash){
        return
      }

      if(this.triedAlready.has(hash)){
        const check = this.triedAlready.get(hash)
        const checkStamp =  (Date.now() - check.stamp) / 1000
        if(check.wait >= checkStamp){
          return
        }
      }

      // if(this.trackers.has(hash)){
      //   const checkTracker = this.trackers.get(hash)
      //   const checkRelay = this.relays.get(ih)
      //   if(checkRelay.every((data) => {return checkTracker.hash !== data.hash})){
      //     // checkRelay.push(checkTracker)
      //     // if(!checkTracker.relays.includes(ih)){
      //     //   checkTracker.relays.push(ih)
      //     // }
      //     checkTracker.send(JSON.stringify({action: 'add', relay: ih, reply: true}))
      //   }
      //   return
      // }

      if(this.trackers.has(hash)){
        const checkTracker = this.trackers.get(hash)
        const checkRelay = this.relays.get(ih)
        if(checkRelay.every((data) => {return checkTracker.hash !== data.hash})){
          // checkRelay.push(checkTracker)
          // if(!checkTracker.relays.includes(ih)){
          //   checkTracker.relays.push(ih)
          // }
          checkTracker.send(JSON.stringify({action: 'add', relay: ih, reply: true}))
        }
        return
      }

      if(this.limit.serverConnections){
        if(this.relays.get(ih).length < this.limit.serverConnections){
          const relay = `ws://${peer.host}:${peer.port}/relay/${ih}`
          const con = new WebSocket(relay)
          con.server = false
          con.active = true
          con.relay = ih
          con.proc = false
          // con.hash = hash
          self.onRelaySocketConnection(con)
          return
        }
    } else {
      const relay = `ws://${peer.host}:${peer.port}/relay/${ih}`
      const con = new WebSocket(relay)
      con.server = false
      con.active = true
      con.relay = ih
      con.proc = false
      // con.hash = hash
      self.onRelaySocketConnection(con)
      return
    }
  }
    if(opts.init){
      this.create(() => {
        console.log('now listening')
      })
    }
  }

  turnOnHTTP(){
    this.http.listen(this.TRACKERPORT, this.TRACKERHOST)
  }

  midDHT(){
    this.relay.listen(this.DHTPORT, this.DHTHOST)
  }

  turnOffHTTP(){
    this.http.close((err) => {
      if(err){
        this.emit('error', err)
      }
    })
  }

  turnWeb(){
    this.http.on('error', this.http.onError)
    this.http.on('listening', this.http.onListening)
    this.http.on('request', this.http.onRequest)
    this.http.on('close', this.http.onClose)
  }

  turnSocket(){
    this.ws.on('listening', this.ws.onListening)
    this.ws.on('close', this.ws.onClose)
    this.ws.on('error', this.ws.onError)
    this.ws.on('connection', this.ws.onConnection)
  }

  turnRelay(){
    this.relay.on('ready', this.relay.onReady)
    this.relay.on('listening', this.relay.onListening)
    this.relay.on('error', this.relay.onError)
    this.relay.on('close', this.relay.onClose)
    this.relay.on('peer', this.relay.onPeer)
  }

  _filter(infoHash, params, cb){
    // const hashes = (() => {if(!opts.hashes){throw new Error('must have hashes')}return Array.isArray(opts.hashes) ? opts.hashes : opts.hashes.split(',')})()
    if(this.status){
      if(this.hashes.has(infoHash)){
        cb(null)
      } else {
        cb(new Error('disallowed torrent'))
      }
    } else {
      cb(null)
    }
  }

  genKey(){
    const test = ed.createSeed()
    const check = ed.createKeyPair(test)
    const useData = {seed: test.toString('hex'), pub: check.publicKey.toString('hex'), pri: check.secretKey.toString('hex')}
    fs.writeFileSync(path.join(this.dir, 'user', 'temp.txt'), JSON.stringify(useData))
    setTimeout(() => {fs.rmSync(path.join(this.dir, 'user', 'temp.txt'), {force: true})}, 300000)
    const sig = ed.sign(this.test, useData.pub, useData.pri)
    return {pub: useData.pub, sig}
  }

  saveKey(e){
    const sig = ed.sign(this.test, e.pub, e.pri)
    this.emit('ev', 'signed data using key')
    return {pub: e.pub, sig}
  }

  talkToRelay(){
    for(const test of this.relays.keys()){
      if(this.limit.serverConnections && this.relays.get(test).length >= this.limit.serverConnections){
        continue
      } else {
        this.relay.lookup(test, (err, num) => {
          if(err){
            this.emit('error', err)
          } else {
            this.emit('ev', test + ': ' + num)
          }
        })
        this.relay.announce(test, this.TRACKERPORT, (err) => {
          if(err){
            this.emit('error', err)
          } else {
            this.emit('ev', 'announced ' + test)
          }
        })
      }
    }
  }

  // runTheRelay(data){
  //   const test = crypto.createHash('sha1').update(data).digest('hex')
  //   this.relay.lookup(test, (err, num) => {
  //     if(err){
  //       this.emit('error', err)
  //     } else {
  //       this.emit('ev', test + ': ' + num)
  //     }
  //   })
  //   this.relay.announce(test, this.TRACKERPORT, (err) => {
  //     if(err){
  //       this.emit('error', err)
  //     } else {
  //       this.emit('ev', 'announced ' + test)
  //     }
  //   })
  // }

  create(cb = null){
    this.turnRelay()
    this.turnSocket()
    this.turnWeb()
    this.midDHT()
    this.turnOnHTTP()
    this.talkToRelay()
    this.intervalRelay = setInterval(() => {
      this.talkToRelay()
    }, this.timer.active)

    this.intervalActive = setInterval(() => {
      for(const test in this.trackers.values()){
        if(!test.active){
          test.terminate()
          continue
        }
        test.active = false
        test.send(JSON.stringify({action: 'ping'}))
      }
    }, this.timer.inactive)
    if(cb){
      cb()
    }
  }

  destroy(cb = null){
    this.http.close((err) => {
      this.emit('error', err)
    })
    this.ws.close((err) => {
      this.emit('error', err)
    })
    this.relay.destroy()
    if(this.refresh){
      clearInterval(this.refresh)
    }
    clearInterval(this.intervalRelay)
    clearInterval(this.intervalActive)
    this.trackers.clear()
    this.relays.clear()
    this.hashes.clear()
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
    this.serverCount = this.serverCount + 1
    // ifhash sent from messages exists already in this.trackers then close the socket
    const self = this
    socket.onOpen = function(){
      // do limit check
      // send the right messages
      // self.trackers[socket.hash] = socket
      if(socket.hash){
        if(self.triedAlready.has(socket.hash)){
          self.triedAlready.delete(socket.hash)
        }
      }
      if(!socket.server){
        socket.send(JSON.stringify({hash: self.hash, key: self.key, address: self.address, web: self.web, host: self.host, port: self.port, domain: self.domain, relay: socket.relay, status: self.status, sig: self.sig, action: 'session', reply: true}))
        delete socket.relay
      }
    }
    socket.onError = function(err){
      let useSocket
      if(socket.hash){
        useSocket = socket.hash
        if(self.triedAlready.has(socket.hash)){
          const check = self.triedAlready.get(socket.hash)
          check.stamp = Date.now()
          check.wait = check.wait * 2
        } else {
          self.triedAlready.set(socket.hash, {stamp: Date.now(), wait: 1})
        }
      } else {
        useSocket = 'socket'
      }
      // socket.terminate()
      // self.emit('error', 'ws', err)
      self.emit('ev', useSocket + ' had an error, will wait and try to connect later, ' + err.message)
    }
    socket.onMessage = function(data, buffer){
      // do limit check
      // send the right data
      try {
        const message = buffer ? JSON.parse(Buffer.from(data).toString('utf-8')) : JSON.parse(data)
        if(message.action === 'session'){
          if(!message.sig || !ed.verify(message.sig, self.test, message.key) || self.trackers.has(message.hash)){
            socket.close()
            return
          }
          const useRelay = message.relay
          delete message.relay
          message.relays = [useRelay]
          for(const m in message){
            socket[m] = message[m]
          }
          socket.relay = {http: socket.web.http + '/relay/', ws: socket.web.ws + '/relay/'}
          socket.announce = {http: socket.web.http + '/announce/', ws: socket.web.ws + '/announce/'}
          for(const r of socket.relays){
            if(self.relays.has(r)){
              self.relays.get(r).push(socket)
            }
          }
          socket.session = true
          self.trackers.set(socket.hash, socket)
          if(socket.server){
            socket.send(JSON.stringify({hash: self.hash, key: self.key, address: self.address, web: self.web, host: self.host, port: self.port, domain: self.domain, relay: useRelay, status: self.status, sig: self.sig, action: 'session', reply: true}))
          }
        }
        if(message.action === 'add'){
          if(!self.relays.has(message.relay)){
            return
          }

          const checkRelay = self.relays.get(message.relay)
          const i = checkRelay.findIndex((data) => {return socket.hash === data.hash})
          if(i === -1){
            checkRelay.push(socket)
          }

          if(!socket.relays.includes(message.relay)){
            socket.relays.push(message.relay)
          }
        }
        if(message.action === 'sub'){
          if(!self.relays.has(message.relay)){
            return
          }
          if(socket.relays.length === 1 && socket.relays.includes(message.relay)){
            socket.close()
            return
          }

          const checkRelay = self.relays.get(message.relay)
          const i = checkRelay.findIndex((data) => {return socket.hash === data.hash})
          if(i !== -1){
            checkRelay.splice(i, 1)
          }

          if(socket.relays.includes(message.relay)){
            socket.relays.splice(socket.relays.indexOf(message.relay), 1)
          }
        }
        if(message.action === 'ping'){
          socket.send(JSON.stringify({action: 'pong'}))
        }
        if(message.action === 'pong'){
          socket.active = true
        }
        if(message.action === 'on'){
          for(const r of socket.relays){
            if(self.relays.has(r)){
              const checkRelay = self.relays.get(r)
              const i = checkRelay.find((soc) => {return socket.hash === soc.hash})
              if(i){
                i.session = true
              }
            }
          }
        }
        if(message.action === 'off'){
          for(const r of socket.relays){
            if(self.relays.has(r)){
              const checkRelay = self.relays.get(r)
              const i = checkRelay.find((soc) => {return socket.hash === soc.hash})
              if(i){
                i.session = false
              }
            }
          }
        }
      } catch (error) {
        self.emit('ev', socket.hash || 'socket' + ' had an error, will wait and try to connect later, ' + error.message)
        socket.close()
      }
    }
    socket.onClose = function(code, reason){
      socket.handleListeners()
      self.serverCount = self.serverCount - 1

      if(socket.relays){
        for(const soc of socket.relays){
          if(self.relays.has(soc)){
            const checkRelay = self.relays.get(soc)
            const i = checkRelay.findIndex((data) => {return socket.hash === data.hash})
            if(i !== -1){
              checkRelay.splice(i, 1)
            }
          }
        }
      }

      if(socket.hash){
        if(self.trackers.has(socket.hash)){
          self.trackers.delete(socket.hash)
        }
      }

      self.emit('ev', code + ': ' + reason.toString())
    }
    socket.handleListeners = () => {
      socket.off('open', socket.onOpen)
      socket.off('error', socket.onError)
      socket.off('message', socket.onMessage)
      socket.off('close', socket.onClose)
    }
    socket.on('open', socket.onOpen)
    socket.on('error', socket.onError)
    socket.on('message', socket.onMessage)
    socket.on('close', socket.onClose)
  }

  onHttpRequest (req, res, opts = {}) {
    opts.trustProxy = opts.trustProxy || this._trustProxy

    let params
    try {
      params = parseHttpRequest(req, opts)
      params.httpReq = req
      params.httpRes = res
      params.proto = false
    } catch (err) {
      res.end(bencode.encode({
        'failure reason': err.message
      }))

      // even though it's an error for the client, it's just a warning for the server.
      // don't crash the server because a client sent bad data :)
      this.emit('warning', err)
      return
    }

    this._onRequest(params, (err, response) => {
      if (err) {
        this.emit('warning', err)
        response = {
          'failure reason': err.message
        }
      }
      if (this.destroyed) return res.end()

      delete response.action // only needed for UDP encoding
      res.end(bencode.encode({...response, relay: params.relay}))

      if (params.action === common.ACTIONS.ANNOUNCE) {
        this.emit(common.EVENT_NAMES[params.event], params.addr, params)
      }
    })
  }

  onWebSocketConnection (socket, opts = {}) {
    this.clientCount = this.clientCount + 1
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
      params.proto = true
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
          info_hash: hex2bin(params.info_hash),
          relay: params.relay
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
        response.interval = Math.ceil(this.timer.interval / 1000 / 5)
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
    this.clientCount = this.clientCount - 1

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
      if(this.limit.refreshConnections && this.clientCount >= this.limit.refreshConnections){
        const relay = crypto.createHash('sha1').update(params.info_hash).digest('hex')
        const checkHas = this.relays.has(relay)
        if(checkHas){
          const checkGet = this.relays.get(relay).filter((data) => {return data.session})
          if(params.proto){
            params.relay = checkGet.length ? checkGet[Math.floor(Math.random() * checkGet.length)].announce.ws + params.info_hash : ''
          } else {
            params.relay = checkGet.length ? checkGet[Math.floor(Math.random() * checkGet.length)].announce.http + params.info_hash : ''
          }
        } else {
          params.relay = ''
        }
        this.turnOffHTTP()
        cb(new Error('Refreshing'))
      } else if(this.limit.clientConnections && this.clientCount >= this.limit.clientConnections){
        const relay = crypto.createHash('sha1').update(hash).digest('hex')
        const checkHas = this.relays.has(relay)
        if(checkHas){
          const checkGet = this.relays.get(relay).filter((data) => {return data.session})
          if(params.proto){
            params.relay = checkGet.length ? checkGet[Math.floor(Math.random() * checkGet.length)].announce.ws + params.info_hash : ''
          } else {
            params.relay = checkGet.length ? checkGet[Math.floor(Math.random() * checkGet.length)].announce.http + params.info_hash : ''
          }
        } else {
          params.relay = ''
        }
        cb(new Error('Relaying'))
      } else {
        params.relay = ''
        this._onAnnounce(params, cb)
      }
    } else if (params && params.action === common.ACTIONS.SCRAPE) {
      this._onScrape(params, cb)
    } else {
      cb(new Error('Invalid action'))
    }
  }

  _onAnnounce (params, cb) {
    const self = this

    getOrCreateSwarm((err, swarm) => {
      if (err) return cb(err)
      announce(swarm)
    })

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
        if (!response.interval) response.interval = Math.ceil(this.timer.interval / 1000)

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
        flags: { min_request_interval: Math.ceil(this.timer.interval / 1000) }
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

function noop () {}

export default Server
