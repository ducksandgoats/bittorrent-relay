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
 * @param {String}  opts.host     host used for server
 * @param {Number}  opts.port     port used for server
 * @param {String}  opts.domain     domain name that will be used
 * @param {Boolean}  opts.trustProxy     trust 'x-forwarded-for' header from reverse proxy
 * @param {Boolean}  opts.auth     password to add infohashes
 * @param {String}  opts.dir     directory to store config files
 * @param {Array|String}  opts.hashes     join the relays for these hashes, array of hashes or comma separated string of hashes
 * @param {Object}  opts.user    user data like public key and private key
 * @param {Boolean} opts.stats          enable web-based statistics?
 * @param {Object} opts.limit       limit the connections of the relay and the hashes
 * @param {Boolean} opts.status          accept only the hashes from the hashes array in the hashes option
 * @param {Boolean}  opts.index    serve an html file when the request is to /
 * @param {Number}  opts.peersCacheLength    max amount of elements in cache, default is 1000
 * @param {Number}  opts.peersCacheTtl    max amount of time to hold elements in cache, default is 20 minutes
 * @param {Boolean}  opts.init    automatically start once instantiated
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
    this.limit = typeof(opts.limit) === 'object' && !Array.isArray(opts.limit) ? opts.limit : {}
    this.timer = typeof(opts.timer) === 'object' && !Array.isArray(opts.timer) ? opts.timer : {}
    this.limit.serverConnections = this.limit.serverConnections || 0
    this.limit.clientConnections = this.limit.clientConnections || 0
    this.limit.refreshConnections = this.limit.refreshConnections || 0
    if(this.limit.clientConnections && this.limit.refreshConnections && this.limit.refreshConnections >= this.limit.clientConnections){
      throw new Error('refreshConnections must be lower than clientConnections')
    }
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
    // if(!opts.domain){
    //   throw new Error('must have a domain')
    // }
    this.domain = opts.domain
    this.timer.inactive = this.timer.inactive || 1 * 60 * 1000
    this.timer.active = this.timer.active || 5 * 60 * 1000
    this.server = opts.server || '0.0.0.0'
    if(!opts.host){
      throw new Error('must have host')
    }
    this.host = opts.host
    this.port = opts.port || 10509
    this.address = `${this.host}:${this.port}`
    this._trustProxy = Boolean(opts.trustProxy)
    this.web = `${this.domain || this.host}:${this.port}`
    this.id = crypto.createHash('sha1').update(this.address).digest('hex')
    this.sockets = new Map()
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
      this.sig = ed.sign(this.test, this.user.pub, this.user.priv).toString('hex')
      this.name = this.user.pub
      this.title = crypto.createHash('sha1').update(this.name).digest('hex')
      this.emit('ev', 'signed data using key')
    } catch (error) {
      this.emit('ev', 'key generation error: ' + error.message)
      const useCheck = this.genKey()
      this.sig = useCheck.sig
      this.name = useCheck.pub
      this.title = crypto.createHash('sha1').update(this.name).digest('hex')
      this.emit('ev', 'new key data was created, check ' + path.join(this.dir, 'user') + ' for new key data, temp.txt will be deleted in 5 minutes')
    }

    if(!opts.hashes || !Array.isArray(opts.hashes) || !opts.hashes.every((data) => {return typeof(data) === 'string'})){
      throw new Error('hashes must be an array')
    }

    this.hashes = new Set(opts.hashes)
    fs.writeFile(path.join(this.dir, 'hashes.txt'), JSON.stringify(Array.from(this.hashes)), {}, (err) => {
      if(err){
        this.emit('error', err)
      } else {
        this.emit('ev', 'saved hashes')
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
      // for(const socket in self.sockets.values()){
      //   if(socket.readyState === 1){
      //     socket.send(JSON.stringify({action: 'web', domain: self.domain, host: self.host, port: self.port, web: self.web, id: self.id}))
      //   }
      // }
      self.sockets.forEach((data) => {data.send(JSON.stringify({action: 'on'}))})
      if(this.limit.clientConnections){
        if(self.refresh){
          clearInterval(self.refresh)
        }
        self.refresh = setInterval(() => {
          if(self.clientCount >= self.limit.clientConnections){
            self.turnOffHTTP()
          }
        }, this.timer.activity)
      }

      self.talkToRelay()

      this.intervalRelay = setInterval(() => {
        this.talkToRelay()
      }, this.timer.active)
  
      this.intervalActive = setInterval(() => {
        for(const test in this.sockets.values()){
          if(!test.relays.length){
            if(!test.active){
              test.terminate()
              continue
            } else {
              test.close()
              continue
            }
          }
          if(!test.active){
            test.terminate()
            continue
          } else {
            test.active = false
            test.send(JSON.stringify({action: 'ping'}))
          }
        }
      }, this.timer.inactive)
      
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
        if(req.url.startsWith('/announce?')){
          this.onHttpRequest(req, res)
        } else if(req.url.startsWith('/relay?')){
          const useParams = new URLSearchParams(req.url.slice(req.url.indexOf('?')))
          this.onHttpRelay(req, res, useParams)
        } else if(req.method === 'HEAD' && req.url === '/'){
          res.statusCode = 200
          res.end()
        } else if(req.method === 'GET' && req.url === '/'){
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/plain')
          res.end('thanks for testing bittorrent-relay')
        } else if(this.index && req.method === 'GET' && req.url === '/index.html'){
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

        } else if(this.stats && req.method === 'GET' && req.url.startsWith('/stats')){

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

          if(req.url === '/stats.html'){
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
          } else if(req.url === '/stats.json'){
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(stats))
          } else {
            throw new Error('invalid route for stats')
          }

        } else if(req.method === 'GET' && req.url === '/hash.html'){
          res.setHeader('Content-Type', 'text/html')
          res.end(`<html><head><title>Relay</title></head><body>${(() => {const arr = [];for(const testing of this.hashes.keys()){arr.push(testing)};return arr;})().join('\n')}</body></html>`)
        } else if(req.method === 'GET' && req.url === '/hash.json'){
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(Array.from(this.hashes)))
        } else if(req.method === 'GET' && req.url === '/id.html'){
          res.setHeader('Content-Type', 'text/html')
          res.end(`<html><head><title>Relay</title></head><body>${(() => {const arr = [];this.sockets.forEach((data) => {arr.push(data.id)});return arr;})().join('\n')}</body></html>`)
        } else if(req.method === 'GET' && req.url === '/id.json'){
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify((() => {const arr = [];this.sockets.forEach((data) => {arr.push(data.id)});return arr;})()))
        } else if(req.method === 'GET' && req.url === '/address.html'){
          res.setHeader('Content-Type', 'text/html')
          res.end(`<html><head><title>Relay</title></head><body>${(() => {const arr = [];this.sockets.forEach((data) => {arr.push(data.address)});return arr;})().join('\n')}</body></html>`)
        } else if(req.method === 'GET' && req.url === '/address.json'){
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify((() => {const arr = [];this.sockets.forEach((data) => {arr.push(data.address)});return arr;})()))
        } else if(req.method === 'GET' && req.url === '/title.html'){
          res.setHeader('Content-Type', 'text/html')
          res.end(`<html><head><title>Relay</title></head><body>${(() => {const arr = [];this.sockets.forEach((data) => {arr.push(data.title)});return arr;})().join('\n')}</body></html>`)
        } else if(req.method === 'GET' && req.url === '/title.json'){
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify((() => {const arr = [];this.sockets.forEach((data) => {arr.push(data.title)});return arr;})()))
        } else if(req.method === 'GET' && req.url === '/name.html'){
          res.setHeader('Content-Type', 'text/html')
          res.end(`<html><head><title>Relay</title></head><body>${(() => {const arr = [];this.sockets.forEach((data) => {arr.push(data.name)});return arr;})().join('\n')}</body></html>`)
        } else if(req.method === 'GET' && req.url === '/name.json'){
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify((() => {const arr = [];this.sockets.forEach((data) => {arr.push(data.name)});return arr;})()))
        } else if(req.method === 'POST' && req.url.startsWith('/add/') && this.auth){
          let useAuth = ''
          let useRes
          function onData(data){
            useAuth = useAuth + data.toString()
          }
          function onEnd(){
            const sign = ed.sign(this.test, self.user.pub, useAuth)
            if(!ed.verify(sign, this.test, self.name) || self.sig !== sign.toString('hex')){
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
                self.relay.announce(testHash, self.port, (err) => {
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
                    self.emit('ev', 'saved hashes')
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
            const sign = ed.sign(this.test, self.name, useAuth)
            if(!ed.verify(sign, this.test, self.name) || self.sig !== sign.toString('hex')){
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
                    self.emit('ev', 'saved hashes')
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
      // this.http.handleListeners()

      clearInterval(this.intervalRelay)
  
      clearInterval(this.intervalActive)
      // this.ws.clients.forEach((data) => {
      //   data.send(JSON.stringify({action: 'off'}))
      //   data.terminate()
      // })
      self.sockets.forEach((data) => {
        data.send(JSON.stringify({action: 'off'}))
      })
      this.triedAlready.clear()

      if(this.limit.clientConnections){
        if(self.refresh){
          clearInterval(self.refresh)
        }
        self.refresh = setInterval(() => {
          if(self.clientCount <= self.limit.clientConnections){
            if(self.limit.refreshConnections){
              if(self.clientCount < self.limit.refreshConnections){
                // self.turnWeb()
                self.turnOnHTTP()
              }
            } else {
              // self.turnWeb()
              self.turnOnHTTP()
            }
          }
        }, this.timer.activity)
      }

      this.listening = false
      self.emit('close', 'http')
    }
    // this.http.handleListeners = () => {
    //   this.http.off('error', this.http.onError)
    //   this.http.off('listening', this.http.onListening)
    //   this.http.off('request', this.http.onRequest)
    //   this.http.off('close', this.http.onClose)
    // }

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
      if(req.url === '/announce'){
        socket.upgradeReq = req
        self.onWebSocketConnection(socket)
      } else if(req.url.startsWith('/relay?')){
        const params = new URLSearchParams(req.url.slice(req.url.indexOf('?')))

        const getRelayHash = params.has('relay_hash') ? params.get('relay_hash') : null
        const checkRelayHash = getRelayHash && typeof(getRelayHash) === 'string' && getRelayHash.length === 40

        const getId = params.has('id') ? params.get('id') : null
        const checkId = getId && typeof(getId) === 'string' && getId.length === 40

        const checkHasSocket = getId ? this.sockets.has(getId) : null
        const checkHasRelay = getRelayHash ? this.relays.has(getRelayHash) : null
        if(!checkRelayHash || !checkId || checkHasSocket || !checkHasRelay){
          socket.send(JSON.stringify({action: 'failure reason', error: 'there was a error, check the other properties of this object', relay_hash: checkRelayHash, id: checkId, socket: checkHasSocket, relay: checkHasRelay}))
          socket.close()
          return
        }
        // have id and relay in the url routes
        // have different functions to handle connections and extras
        if(this.limit.serverConnections){
          if(this.relays.get(getRelayHash).length < this.limit.serverConnections){
            socket.id = getId
            socket.server = true
            socket.active = true
            socket.relay = getRelayHash
            socket.relays = []
            socket.proc = false
            this.sockets.set(socket.id, socket)
            socket.send(JSON.stringify({id: self.id, title: self.title, name: self.name, address: self.address, web: self.web, host: self.host, port: self.port, domain: self.domain, relay: getRelayHash, status: self.status, sig: self.sig, action: 'session'}))
            this.onRelaySocketConnection(socket)
          }
        } else {
          socket.id = getId
          socket.server = true
          socket.relay = getRelayHash
          socket.relays = []
          socket.active = true
          socket.proc = false
          this.sockets.set(socket.id, socket)
          socket.send(JSON.stringify({id: self.id, title: self.title, name: self.name, address: self.address, web: self.web, host: self.host, port: self.port, domain: self.domain, relay: getRelayHash, status: self.status, sig: self.sig, action: 'session'}))
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
      const ih = infoHash.toString('hex')

      if(!this.relays.has(ih)){
        return
      }

      const useAddress = `${peer.host}:${peer.port}`
      const id = crypto.createHash('sha1').update(useAddress).digest('hex')
      if(self.address === useAddress || self.id === id){
        return
      }

      if(this.triedAlready.has(id)){
        const check = this.triedAlready.get(id)
        const checkStamp =  (Date.now() - check.stamp) / 1000
        if(check.wait >= checkStamp){
          return
        }
      }

      // if(this.sockets.has(id)){
      //   const checkTracker = this.sockets.get(id)
      //   const checkRelay = this.relays.get(ih)
      //   if(checkRelay.every((data) => {return checkTracker.id !== data.id})){
      //     // checkRelay.push(checkTracker)
      //     // if(!checkTracker.relays.includes(ih)){
      //     //   checkTracker.relays.push(ih)
      //     // }
      //     checkTracker.send(JSON.stringify({action: 'add', relay: ih, reply: true}))
      //   }
      //   return
      // }

      if(this.sockets.has(id)){
        const checkTracker = this.sockets.get(id)
        if(checkTracker.readyState === 1){
          const checkRelay = this.relays.get(ih)
          if(checkRelay.every((data) => {return checkTracker.id !== data.id})){
            // checkRelay.push(checkTracker)
            // if(!checkTracker.relays.includes(ih)){
            //   checkTracker.relays.push(ih)
            // }
            checkTracker.send(JSON.stringify({action: 'add', relay: ih, reply: true}))
          }
        }
        return
      }

      if(this.limit.serverConnections){
        if(this.relays.get(ih).length < this.limit.serverConnections){
          const relay = `ws://${useAddress}/relay?relay_hash=${ih}&id=${this.id}`
          const con = new WebSocket(relay)
          con.server = false
          con.active = true
          con.relay = ih
          con.relays = []
          con.proc = false
          con.id = id
          this.sockets.set(con.id, con)
          self.onRelaySocketConnection(con)
          return
        }
    } else {
      const relay = `ws://${useAddress}/relay?relay_hash=${ih}&id=${this.id}`
      const con = new WebSocket(relay)
      con.server = false
      con.active = true
      con.relay = ih
      con.relays = []
      con.proc = false
      con.id = id
      this.sockets.set(con.id, con)
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
    this.http.listen(this.port, this.server)
  }

  turnOnDHT(){
    this.relay.listen(this.port, this.server)
  }

  turnOffDHT(){
    this.relay.destroy()
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
    if(this.hashes.has(infoHash)){
      cb(null)
    } else {
      cb(new Error('disallowed torrent'))
    }
  }

  genKey(){
    const test = ed.createSeed()
    const check = ed.createKeyPair(test)
    const useData = {seed: test.toString('hex'), pub: check.publicKey.toString('hex'), priv: check.secretKey.toString('hex')}
    fs.writeFileSync(path.join(this.dir, 'user', 'temp.txt'), JSON.stringify(useData))
    setTimeout(() => {fs.rmSync(path.join(this.dir, 'user', 'temp.txt'), {force: true})}, 300000)
    const sig = ed.sign(this.test, useData.pub, useData.priv).toString('hex')
    return {pub: useData.pub, sig}
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
        this.relay.announce(test, this.port, (err) => {
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
  //   this.relay.announce(test, this.port, (err) => {
  //     if(err){
  //       this.emit('error', err)
  //     } else {
  //       this.emit('ev', 'announced ' + test)
  //     }
  //   })
  // }

  create(cb = null){
    this.turnRelay()
    this.turnWeb()
    this.turnSocket()
    this.turnOnDHT()
    this.turnOnHTTP()
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
    this.sockets.clear()
    this.relays.clear()
    this.hashes.clear()
    this.triedAlready.clear()
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
    // ifhash sent from messages exists already in this.sockets then close the socket
    const self = this
    socket.onOpen = function(){
      // do limit check
      // send the right messages
      // self.sockets[socket.id] = socket
      if(socket.id){
        if(self.triedAlready.has(socket.id)){
          self.triedAlready.delete(socket.id)
        }
      }
      socket.send(JSON.stringify({id: self.id, title: self.title, name: self.name, address: self.address, web: self.web, host: self.host, port: self.port, domain: self.domain, relay: socket.relay, status: self.status, sig: self.sig, action: 'session'}))
    }
    socket.onError = function(err){
      let useSocket
      if(socket.id){
        useSocket = socket.id
        if(self.triedAlready.has(socket.id)){
          const check = self.triedAlready.get(socket.id)
          check.stamp = Date.now()
          check.wait = check.wait * 2
        } else {
          self.triedAlready.set(socket.id, {stamp: Date.now(), wait: 1})
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
        const message = JSON.parse(data.toString('utf-8'))
        if(message.action === 'session'){
          if(socket.relay !== message.relay || message.title !== crypto.createHash('sha1').update(message.name).digest('hex') || message.id !== crypto.createHash('sha1').update(message.address).digest('hex') || !ed.verify(message.sig, self.test, message.name)){
            socket.close()
            return
          }
          if(!socket.relays.includes(message.relay)){
            socket.relays.push(message.relay)
          }
          // message.relays = [useRelay]
          delete message.relay
          delete socket.relay
          for(const m in message){
            socket[m] = message[m]
          }
          for(const r of socket.relays){
            if(self.relays.has(r)){
              self.relays.get(r).push(socket)
            }
          }
          socket.session = true
        }
        if(message.action === 'add'){
          if(!self.relays.has(message.relay)){
            return
          }

          const checkRelay = self.relays.get(message.relay)
          const i = checkRelay.findIndex((data) => {return socket.id === data.id})
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
          const i = checkRelay.findIndex((data) => {return socket.id === data.id})
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
              const i = checkRelay.find((soc) => {return socket.id === soc.id})
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
              const i = checkRelay.find((soc) => {return socket.id === soc.id})
              if(i){
                i.session = false
              }
            }
          }
        }
      } catch (error) {
        self.emit('ev', socket.id || 'socket' + ' had an error, will wait and try to connect later, ' + error.message)
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
            const i = checkRelay.findIndex((data) => {return socket.id === data.id})
            if(i !== -1){
              checkRelay.splice(i, 1)
            }
          }
        }
      }

      if(socket.id){
        if(self.sockets.has(socket.id)){
          self.sockets.delete(socket.id)
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
          'failure reason': err.message,
          relay: params.relay
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

  onHttpRelay(req, res, par){
    // const useRelayHash = req.url.slice(0, req.url.indexOf('?')).replace('/relay/', '')
    const getRelayHash = par.has('relay_hash') ? par.get('relay_hash') : null
    const checkRelayHash = getRelayHash && typeof(getRelayHash) === 'string' && getRelayHash.length === 40
    const getId = par.has('id') ? par.get('id') : null
    const checkId = getId && typeof(getId) === 'string' && getId.length === 40
    if(!checkRelayHash && !checkId){
      res.end(bencode.encode({'failure reason': 'must have relay-hash or id'}))
    }
    const check = {}
    if(checkRelayHash){
      check.relay_hash = this.relays.has(getRelayHash)
    }
    if(checkId){
      check.id = this.sockets.has(getId)
    }
    res.end(bencode.encode(check))
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
      if(this.limit.clientConnections && this.clientCount >= this.limit.clientConnections){
        const relay = crypto.createHash('sha1').update(params.info_hash).digest('hex')
        const checkHas = this.relays.has(relay)
        if(checkHas){
          const checkGet = this.relays.get(relay).filter((data) => {return data.session})
          params.relay = checkGet.length ? `${params.type}://${checkGet[Math.floor(Math.random() * checkGet.length)].web}/announce` : ''
        } else {
          params.relay = ''
        }
        this.turnOffHTTP()
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

    if (this.status) {
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
