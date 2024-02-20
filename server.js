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
 * @param {Boolean} opts.data      enable routes to share internal data to users
 * @param {Boolean} opts.status          accept only the hashes from the hashes array in the hashes option
 * @param {Boolean|String}  opts.index    serve an html file when the request is to /
 * @param {Boolean|String}  opts.peersCacheLength    max amount of elements in cache, default is 1000
 * @param {Boolean|String}  opts.peersCacheTtl    max amount of time to hold elements in cache, default is 20 minutes
 */

// * @param {Function}  opts.extendRelay    have custom capabilities
// * @param {Function}  opts.extendHandler     handle custom routes
// * @param {Number}  opts.relayTimer       interval to find and connect to other trackers (ms)

class Server extends EventEmitter {
  constructor (opts = {}) {
    super()
    debug('new server %s', JSON.stringify(opts))

    const self = this
    
    this.stats = opts.stats
    this.data = opts.data
    this.limit = typeof(opts.limit) === 'object' && !Array.isArray(opts.limit) ? opts.limit : {}
    this.timer = typeof(opts.timer) === 'object' && !Array.isArray(opts.timer) ? opts.timer : {}
    this.serverConnections = opts.limit.serverConnections || 0
    this.clientConnections = opts.limit.clientConnections || 0
    this.refreshConnections = this.clientConnections ? this.clientConnections + (opts.limit.refresh ? opts.limit.refreshConnections || 1000 : 1000) : 0
    this.refreshLimit = opts.limit.refreshLimit || 0
    this.clientOrRefresh = Boolean(opts.limit.clientOrRefresh)
    this.activity = opts.timer.activity || 5 * 60 * 1000

    this.dir = path.join(opts.dir || __dirname, 'dir')
    this.index = Boolean(opts.index)
    fs.mkdirSync(this.dir)
    if(this.index === true){
      fs.writeFileSync(path.join(this.dir, 'index.html'), '<html><head><title>Relay</title></head><body><h1>Relay</h1><p>Relay</p></body></html>')
    } else if(this.index === false){
      fs.rmSync(path.join(this.dir, 'index.html'), {force: true})
    } else {
      try {
        fs.writeFileSync(path.join(this.dir, 'index.html'), fs.readFileSync(this.index).toString('utf-8'))
        this.index = true
      } catch (error) {
        console.error(error)
        fs.rmSync(path.join(this.dir, 'index.html'))
        this.index = false
      }
    }

    this.auth = opts.auth || null
    this.user = opts.user || null
    if(this.user === true){
      const text = 'created key data, check ' + path.join(this.dir, 'user') + ' for new key data, temp.txt will be deleted in 5 minutes'
      const {data} = saveKey(text)
      this.user = data
    } else if(this.user === false){
      const text = 'key data is missing so new key data was created, check ' + path.join(this.dir, 'user') + ' for new key data, temp.txt will be deleted in 5 minutes'
      if(fs.existsSync(path.join(this.dir, 'user', 'user.txt'))){
        const check = JSON.parse(fs.readFileSync(path.join(this.dir, 'user', 'user.txt')).toString())
        if(!check.pub || !check.sig || !check.msg){
          const {data} = saveKey(text)
          this.user = data
        } else {
          this.user = check
        }
      } else {
        const {data} = saveKey(text)
        this.user = data
      }
    } else {
      try {
        const check = this.user
        const msg = 'user'
        const sig = ed.sign(msg, check.pub, check.priv)
        if(ed.verify(sig, msg, check.pub)){
          const useData = {pub: check.pub, msg, sig}
          fs.writeFileSync(path.join(this.dir, 'user', 'user.txt'), JSON.stringify(useData))
          this.emit('ev', 'key data given is good')
          this.user = useData
        } else {
          throw new Error('key data given does not match')
        }
      } catch (error) {
        console.error(error)
        const text = 'key data given is bad, check ' + path.join(this.dir, 'user') + ' for new key data, temp.txt will be deleted in 5 minutes'
        const {data} = saveKey(text)
        this.user = data
      }
    }
    this.key = this.user.pub

    this.intervalMs = opts.timer.interval ? opts.timer.interval : 10 * 60 * 1000
    this.peersCacheLength = opts.peersCacheLength
    this.peersCacheTtl = opts.peersCacheTtl
    this.destroyed = false
    this.torrents = {}
    this.http = null
    this.ws = null
    this.domain = opts.domain || null
    this.inactive = opts.timer.inactive || 1 * 60 * 1000
    this.active = opts.timer.active || 5 * 60 * 1000
    this.DHTPORT = opts.dhtPort || 16881
    this.TRACKERPORT = opts.trackerPort || 16969
    this.DHTHOST = opts.dhtHost || '0.0.0.0'
    this.TRACKERHOST = opts.trackerHost || '0.0.0.0'
    this.host = opts.host
    if(!this.host || this.host.includes('0.0.0.0') || this.host.includes('localhost') || this.host.includes('127.0.0.1')){
      throw new Error('must have host')
    }
    this.port = opts.port || this.TRACKERPORT
    this.hostPort = `${this.host}:${this.port}`
    this.address = crypto.createHash('sha1').update(this.hostPort).digest('hex')
    this._trustProxy = Boolean(opts.trustProxy)
    this.dht = {host: this.DHTHOST, port: this.DHTPORT}
    this.tracker = {host: this.TRACKERHOST, port: this.TRACKERPORT}
    this.id = crypto.createHash('sha1').update(this.host + ':' + this.port).digest('hex')
    this.web = `ws://${this.domain || this.host}:${this.port}`
    this.trackers = new Map()
    this.triedAlready = new Map()
    this.status = opts.status || null
    this.hashes = new Set((typeof(opts.hashes) === 'object' && Array.isArray(opts.hashes)) ? opts.hashes : typeof(opts.hashes) === 'string' ? opts.hashes.split(',').filter(Boolean) : [])
    fs.writeFile(path.join(this.dir, 'hashes.txt'), JSON.stringify(Array.from(this.hashes)), {}, (err) => {
      if(err){
        this.emit('error', 'ev', err)
      } else {
        this.emit('ev', 'saved relays')
      }
    })
    this.relays = new Map((() => {const test = [];this.hashes.forEach((data) => {test.push([crypto.createHash('sha1').update(data).digest('hex'), []])});return test;})())
    fs.writeFile(path.join(this.dir, 'relays.txt'), JSON.stringify(Array.from(this.relays.keys())), {}, (err) => {
      if(err){
        this.emit('error', 'ev', err)
      } else {
        this.emit('ev', 'saved relays')
      }
    })
    
    this.http = http.createServer()
    this.http.onError = (err) => {
      self.emit('error', 'http', err)
    }
    this.http.onListening = () => {
      debug('listening')
      // for(const socket in self.trackers.values()){
      //   if(socket.readyState === 1){
      //     socket.send(JSON.stringify({action: 'web', tracker: self.tracker, dht: self.dht, domain: self.domain, host: self.host, port: self.port, web: self.web, id: self.id}))
      //   }
      // }
      if(self.refreshConnections){
        if(self.refresh){
          clearInterval(self.refresh)
        }
        self.refresh = setInterval(() => {
          if(self.refreshConnections){
            if(self.ws.clients.size >= self.refreshConnections){
              self.http.close()
            }
          }
        }, this.activity)
      }

      self.talkToRelay()
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
  
      if(req.url === '/'){
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        res.end('thanks for testing bittorrent-relay')
      } else if(req.url === '/index.html' && req.method === 'GET' && this.index){
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
      } else if(req.url === '/stats.html' && req.method === 'GET' && this.stats){
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

      } else if(req.method === 'GET' && req.url === '/addresses.json' && this.data){
        const arr = []
        for(const i in self.trackers.values()){
          arr.push(i.address)
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(arr))
      } else if(req.method === 'GET' && req.url === '/ids.json' && this.data){
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(Array.from(self.trackers.keys())))
      } else if(req.method === 'GET' && req.url === '/hashes.json' && this.data){
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(Array.from(this.hashes)))
      } else if(req.method === 'GET' && req.url === '/relays.json' && this.data){
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(Array.from(self.relays.keys())))
      } else if(req.method === 'GET' && req.url === '/keys.json' && this.data){
        const arr = []
        for(const i in self.trackers.values()){
          arr.push(i.key)
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(arr))
      } else if(req.method === 'GET' && req.url === '/index.json'){
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify('thanks for using bittorrent-relay'))
      } else if(req.method === 'POST' && req.url.startsWith('/add/') && this.auth){
        let useAuth = ''
        let useRes
        function onData(data){
          useAuth = useAuth + data.toString()
        }
        function onEnd(){
          const sign = ed.sign(self.user.msg, self.user.pub, useAuth)
          if(!ed.verify(sign, self.user.msg, self.user.pub) || self.user.sig !== sign.toString('hex')){
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
                  self.emit('error', 'ev', err)
                } else {
                  self.emit('ev', num)
                }
              })
              self.relay.announce(testHash, self.TRACKERPORT, (err) => {
                if(err){
                  self.emit('error', 'ev', err)
                } else {
                  self.emit('ev', 'announced ' + ih)
                }
              })
              fs.writeFile(path.join(self.dir, 'hashes.txt'), JSON.stringify(Array.from(self.hashes)), {}, (err) => {
                if(err){
                  self.emit('error', 'ev', err)
                } else {
                  self.emit('ev', 'saved relays')
                }
              })
              fs.writeFile(path.join(self.dir, 'relays.txt'), JSON.stringify(Array.from(self.relays.keys())), {}, (err) => {
                if(err){
                  self.emit('error', 'ev', err)
                } else {
                  self.emit('ev', 'saved relays')
                }
              })
              for(const testObj of self.trackers.values()){
                testObj.send(JSON.stringify({action: 'add', relay: testHash, hash: ih}))
              }
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
          const sign = ed.sign(self.user.msg, self.user.pub, useAuth)
          if(!ed.verify(sign, self.user.msg, self.user.pub) || self.user.sig !== sign.toString('hex')){
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
                  // data.send(JSON.stringify({action: 'sub', relay: testHash, hash: ih}))
                  data.close()
                  // data.terminate()
                })
                self.relays.delete(testHash)
              }
              fs.writeFile(path.join(self.dir, 'hashes.txt'), JSON.stringify(Array.from(self.hashes)), {}, (err) => {
                if(err){
                  self.emit('error', 'ev', err)
                } else {
                  self.emit('ev', 'saved relays')
                }
              })
              fs.writeFile(path.join(self.dir, 'relays.txt'), JSON.stringify(Array.from(self.relays.keys())), {}, (err) => {
                if(err){
                  self.emit('error', 'ev', err)
                } else {
                  self.emit('ev', 'saved relays')
                }
              })
              for(const testObj of self.trackers.values()){
                testObj.send(JSON.stringify({action: 'sub', relay: testHash, hash: ih}))
              }
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
    }
    this.http.onClose = () => {
      // this.ws.clients.forEach((data) => {
      //   data.send(JSON.stringify({action: 'off'}))
      //   data.terminate()
      // })
      this.trackers.forEach((data) => {
        // data.send(JSON.stringify({action: 'off'}))
        // data.terminate()
        data.close()
      })
      this.trackers.clear()
      this.triedAlready.clear()
      this.relays.clear()
      this.hashes.forEach((data) => {
        this.relays.set(crypto.createHash('sha1').update(data).digest('hex'), [])
      })

      if(self.refreshConnections){
        if(self.refresh){
          clearInterval(self.refresh)
        }
        self.refresh = setInterval(() => {
          const check = self.clientOrRefresh ? self.refreshConnections : self.clientConnections
          if(self.ws.clients.size <= check){
            if(self.refreshLimit){
              if(self.ws.clients.size <= self.refreshLimit){
                self.http.listen(this.TRACKERPORT, this.TRACKERHOST)
              }
            } else {
              self.http.listen(this.TRACKERPORT, this.TRACKERHOST)
            }
          }
        }, this.activity)
      }

      self.emit('close', 'http')
    }

    this.http.on('error', this.http.onError)
    this.http.on('listening', this.http.onListening)
    this.http.on('request', this.http.onRequest)
    this.http.on('close', this.http.onClose)

    // Add default http request handler on next tick to give user the chance to add
    // their own handler first. Handle requests untouched by user's handler.
    this.ws = new WebSocketServer({
      ...(typeof(opts.ws) === 'object' && !Array.isArray(opts.ws) ? opts.ws : {}),
      perMessageDeflate: false,
      clientTracking: true,
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
        // const relay = crypto.createHash('sha1').update(hash).digest('hex')
        if(action === 'announce'){

          if(self.status){
            if(self.hashes.has(hash)){
              if(self.refreshConnections && self.ws.clients.size >= self.refreshConnections){
                socket.send(JSON.stringify({action: 'failure reason', error: 'at limit, restarting tracker'}))
                socket.close()
                this.http.close()
              } else if(self.clientConnections && self.ws.clients.size >= self.clientConnections){
                let sendData
                const relay = crypto.createHash('sha1').update(hash).digest('hex')
                const checkHas = self.relays.has(relay)
                if(checkHas){
                  const checkGet = self.relays.get(relay)
                  sendData = {action: 'relay', relay: checkGet.length ? checkGet[Math.floor(Math.random() * checkGet.length)].web + '/announce/' + hash : null}
                } else {
                  sendData = {action: 'relay', relay: null}
                }
                socket.send(JSON.stringify(sendData))
                socket.close()
              } else {
                socket.upgradeReq = req
                self.onWebSocketConnection(socket)
              }
            } else {
              socket.send(JSON.stringify({action: 'failure reason', error: 'hash is not supported'}))
              socket.close()
            }
          } else {
            socket.upgradeReq = req
            self.onWebSocketConnection(socket)
          }

          if(self.refreshConnections && self.ws.clients.size >= self.refreshConnections){
            socket.send(JSON.stringify({action: 'failure reason', error: 'at limit, restarting tracker'}))
            socket.close()
            this.http.close()
          } else if(self.clientConnections && self.ws.clients.size >= self.clientConnections){
            let sendData
            if(self.hashes.has(hash)){
              const relay = crypto.createHash('sha1').update(hash).digest('hex')
              const checkHas = self.relays.has(relay)
              if(checkHas){
                const checkGet = self.relays.get(relay)
                sendData = {action: 'relay', relay: checkGet.length ? checkGet[Math.floor(Math.random() * checkGet.length)].web + '/announce/' + hash : null}
              } else {
                sendData = {action: 'relay', relay: null}
              }
            } else {
              sendData = {action: 'relay', relay: null}
            }
            socket.send(JSON.stringify(sendData))
            socket.close()
          } else {
            socket.upgradeReq = req
            self.onWebSocketConnection(socket)
          }

        } else if(action === 'relay'){

          // if(this.triedAlready.has(hash)){
          //   this.triedAlready.delete(hash)
          // }
          if(self.relays.has(hash)){
            if(self.serverConnections && self.relays.get(hash).length >= self.serverConnections ){
              socket.close()
            } else {
              socket.id = null
              socket.server = true
              socket.active = true
              socket.session = false
              socket.relays = [hash]
              socket.hashes = []
              self.onRelaySocketConnection(socket)
            }
          } else {
            socket.close()
          }
          // if(self.trackers.has(hash)){
          //   socket.terminate()
          // } else {
          //   socket.id = hash
          //   socket.server = true
          //   socket.active = true
          //   socket.relays = []
          //   socket.hashes = []
          //   self.onRelaySocketConnection(socket)
          // }

        } else {
          throw new Error('invalid path')
        }
      } catch (error) {
        socket.send(JSON.stringify({action: 'failure reason', error: error.message}))
        socket.close()
      }
    }
    this.ws.onListening = () => {
      self.emit('listening', 'ws')
    }
    this.ws.onClose = () => {
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

      if(this.status && !this.relays.has(infoHash)){
        return
      }

      if(this.serverConnections && this.relays.get(infoHash).length >= this.serverConnections){
        return
      }

      const id = crypto.createHash('sha1').update(peer.host + ':' + peer.port).digest('hex')
      if(self.id === id){
        return
      }

      if(this.trackers.has(id)){
        const check = this.trackers.get(id)
        if(!check.relays.includes(infoHash)){
          check.send(JSON.stringify({action: 'session'}))
        }
        return
      }

      if(this.triedAlready.has(id)){
        const check = this.triedAlready.get(id)
        const checkStamp =  (Date.now() - check.stamp) / 1000
        if(check.wait >= checkStamp){
          return
        }
      }

      const relay = `ws://${peer.host}:${peer.port}/relay/`
      const con = new WebSocket(relay + self.id)
      con.server = false
      con.active = true
      con.session = false
      con.relays = [infoHash]
      con.hashes = []
      con.id = id
      self.onRelaySocketConnection(con)
    })

    this.intervalRelay = setInterval(() => {
      this.talkToRelay()
    }, this.active)

    this.intervalActive = setInterval(() => {
      for(const test in this.trackers.values()){
        if(!test.active){
          test.terminate()
          continue
        }
        test.active = false
        test.send(JSON.stringify({action: 'ping'}))
      }
    }, this.inactive)

    this.talkToRelay()
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
    const useData = {seed: test.toString('hex'), pub: check.publicKey.toString('hex'), priv: check.secretKey.toString('hex')}
    const msg = 'user'
    const sig = ed.sign(msg, useData.pub, useData.priv)
    return {data: {pub: useData.pub, msg, sig}, temp: {seed: useData.seed, priv: useData.priv}}
  }

  saveKey(e){
    const useCheck = genKey()
    fs.writeFileSync(path.join(this.dir, 'user', 'user.txt'), JSON.stringify(useCheck.data))
    fs.writeFileSync(path.join(this.dir, 'user', 'temp.txt'), JSON.stringify(useCheck.temp))
    setTimeout(() => {fs.rmSync(path.join(this.dir, 'user', 'temp.txt'), {force: true})}, 300000)
    this.emit('ev', e)
    return useCheck
  }

  talkToRelay(){
    for(const test of this.relays.keys()){
      if(this.serverConnections && this.relays.get(test).length >= this.serverConnections){
        continue
      } else {
        this.relay.lookup(test, (err, num) => {
          if(err){
            this.emit('error', 'ev', err)
          } else {
            this.emit('ev', test + ': ' + num)
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
  }

  listens(cb = null){
    this.relay.listen(this.DHTPORT, this.DHTHOST)
    this.http.listen(this.TRACKERPORT, this.TRACKERHOST)
    if(cb){
      cb()
    }
  }

  // turnOff(cb = null){
  //   // this.ws.close()
  //   this.relay.destroy()
  //   this.http.close()
  //   if(cb){
  //     cb()
  //   }
  // }

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
      if(socket.id){
        if(self.triedAlready.has(socket.id)){
          self.triedAlready.delete(socket.id)
        }
      }
      socket.send(JSON.stringify({id: self.id, key: self.key, address: self.address, hostPort: self.hostPort, tracker: self.tracker, web: self.web, host: self.host, port: self.port, dht: self.dht, domain: self.domain, relays: Array.from(self.relays.keys()), hashes: Array.from(self.hashes), status: self.status, action: 'session'}))
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
          check = {stamp: Date.now(), wait: 1}
        }
      } else {
        useSocket = 'socket'
      }
      // socket.terminate()
      self.emit('error', 'ws', err)
      self.emit('ev', useSocket + ' had an error, will wait and try to connect later')
    }
    socket.onMessage = function(data, buffer){
      const message = buffer ? JSON.parse(Buffer.from(data).toString('utf-8')) : JSON.parse(data)
      if(message.action === 'session'){
        if(socket.id){
          if(self.trackers.has(socket.id) || socket.id !== message.id){
            socket.close()
            return
          }
        } else {
          socket.id = message.id
        }
        self.trackers.set(socket.id, socket)
        socket.session = true
        for(const relay of socket.relays){
          if(self.relays.has(relay)){
            const check = self.relays.get(relay)
            if(self.serverConnections && check.length >= self.serverConnections && check.some((data) => {return socket.id === data.id})){
              socket.close()
              return
            } else {
              // const i = check.findIndex((data) => {return socket.id === data.id})
              // if(i === -1){
              //   check.push(socket)
              // }
              check.push(socket)
            }
          } else {
            socket.close()
            return
          }
        }
        // socket.relays.forEach((data) => {
        //   if(self.relays.has(data)){
        //     const check = self.relays.get(data)
        //     if(self.serverConnections && check.length >= self.serverConnections){
        //       socket.close()
        //     } else {
        //       check.push(socket)
        //     }
        //   } else {
        //     socket.close()
        //   }
        // })
        socket.status = message.status
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
        // if(!socket.relays.length){
        //   socket.close()
        //   return
        // }
        if(socket.server){
          socket.send(JSON.stringify({id: self.id, key: self.key, address: self.address, hostPort: self.hostPort, tracker: self.tracker, web: self.web, host: self.host, port: self.port, dht: self.dht, domain: self.domain, relays: Array.from(self.relays.keys()), hashes: Array.from(self.hashes), status: self.status, action: 'session'}))
        }
      }
      if(message.action === 'add'){
        if(crypto.createHash('sha1').update(message.hash).digest('hex') === message.relay && self.hashes.has(message.hash) && self.relays.has(message.relay) && socket.relays.includes(message.relay)){
          const check = self.relays.get(message.relay)
          const i = check.findIndex((data) => {return socket.id === data.id})
          if(self.serverConnections && check.length >= self.serverConnections && i !== -1){
            return
          } else {
            socket.relays.push(message.relay)
            check.push(socket)
          }
        }
      }
      if(message.action === 'sub'){
        if(crypto.createHash('sha1').update(message.hash).digest('hex') === message.relay && self.hashes.has(message.hash) && self.relays.has(message.relay) && socket.relays.includes(message.relay)){
          const check = self.relays.get(message.relay)
          const i = check.findIndex((data) => {return socket.id === data.id})
          if(i === -1){
            return
          } else {
            socket.relays.splice(socket.relays.indexOf(message.relay), 1)
            check.splice(check.indexOf(message.relay), 1)
          }
          if(!socket.relays.length){
            socket.close()
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

      if(socket.id){
        self.trackers.delete(socket.id)
      }

      if(socket.relays){
        for(const relay of socket.relays){
          if(self.relays.has(relay)){
            const check = self.relays.get(relay)
            const i = check.findIndex((data) => {return socket.id === data.id})
            if(i !== -1){
              check.splice(i, 1)
            }
          }
        }
      }

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

    this._filter(params.info_hash, params, err => {
      // Presence of `err` means that this announce request is disallowed
      if (err) return cb(err)

      getOrCreateSwarm((err, swarm) => {
        if (err) return cb(err)
        announce(swarm)
      })
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

function noop () {}

export default Server
