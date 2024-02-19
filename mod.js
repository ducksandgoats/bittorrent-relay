export default class Mod {
    constructor(opts, relayFunc, socketFunc){
        const self = this

        this.sockets = sockets
        this.relays = Object.assign({}, ...this.swarms.map((data) => {return {[data]: []}}))
        this.hashes = Object.assign({}, ...this.hashes.map((data) => {return {[data]: []}}))
        this.timeout = tries
        this.relayFunc = relayFunc
        this.socketFunc = socketFunc
    
        this.index = opts.index
        this.stats = opts.stats
        this.limit = opts.limit
        this.dir = path.join(opts.dir || __dirname, 'dir')
        this.auth = opts.auth || null
        this.user = opts.user || null
        this.key = this.user.pub
        this.http = null
        this.ws = null
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
        this.relays = this.hashes.map((data) => {return crypto.createHash('sha1').update(data).digest('hex')})
        this._trustProxy = Boolean(opts.trustProxy)
        this.dht = {host: this.DHTHOST, port: this.DHTPORT}
        this.tracker = {host: this.TRACKERHOST, port: this.TRACKERPORT}
        this.id = crypto.createHash('sha1').update(this.host + ':' + this.port).digest('hex')
        this.web = `ws://${this.domain || this.host}:${this.port}`
        this.status = {cpu: 0, memory: 0, state: 1}
        this.trackers = {}
        this.sendTo = {}
        this.triedAlready = {}
        this.hashes.forEach((data) => {this.sendTo[data] = []})
        this.filter = opts.filter

        this._filter = function (infoHash, params, cb) {
            // const hashes = (() => {if(!opts.hashes){throw new Error('must have hashes')}return Array.isArray(opts.hashes) ? opts.hashes : opts.hashes.split(',')})()
            if(this.filter){
              if(this.hashes.includes(infoHash)){
                cb(null)
              } else {
                cb(new Error('disallowed torrent'))
              }
            } else {
              cb(null)
            }
          }

        function genKey(){
            const test = ed.createSeed()
            const check = ed.createKeyPair(test)
            const useData = {seed: test.toString('hex'), pub: check.publicKey.toString('hex'), priv: check.secretKey.toString('hex')}
            const msg = 'user'
            const sig = ed.sign(msg, useData.pub, useData.priv)
            return {data: {pub: useData.pub, msg, sig}, temp: {seed: useData.seed, priv: useData.priv}}
          }
      
          function saveKey(e){
            const useCheck = genKey()
            fs.writeFileSync(path.join(this.dir, 'user', 'user.txt'), JSON.stringify(useCheck.data))
            fs.writeFileSync(path.join(this.dir, 'user', 'temp.txt'), JSON.stringify(useCheck.temp))
            setTimeout(() => {fs.rmSync(path.join(this.dir, 'user', 'temp.txt'), {force: true})}, 300000)
            this.emit('ev', e)
            return useCheck
          }

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

          fs.writeFile(path.join(this.dir, 'hashes.txt'), JSON.stringify(this.hashes), {}, (err) => {
            if(err){
              this.emit('error', 'ev', err)
            } else {
              this.emit('ev', 'saved hashes')
            }
          })

          fs.writeFile(path.join(this.dir, 'relays.txt'), JSON.stringify(this.relays), {}, (err) => {
            if(err){
              this.emit('error', 'ev', err)
            } else {
              this.emit('ev', 'saved relays')
            }
          })
    
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
            fs.createReadStream(path.join(this.dir, 'index.html')).pipe(res)
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
    
          } else if(req.method === 'GET' && req.url === '/addresses.json'){
            const arr = []
            for(const i in self.trackers){
              arr.push(self.trackers[i].address)
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(arr))
          } else if(req.method === 'GET' && req.url === '/ids.json'){
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(Object.keys(self.trackers)))
          } else if(req.method === 'GET' && req.url === '/hashes.json'){
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(self.hashes))
          } else if(req.method === 'GET' && req.url === '/relays.json'){
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(self.relays))
          } else if(req.method === 'GET' && req.url === '/keys.json'){
            const arr = []
            for(const i in self.trackers){
              arr.push(self.trackers[i].key)
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(arr))
          } else if(req.method === 'GET' && req.url === '/zed.json'){
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
                res.statusCode = 200
                const ih = req.url.replace('/add/', '')
                const testHash = crypto.createHash('sha1').update(ih).digest('hex')
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
                  fs.writeFile(path.join(self.dir, 'hashes.txt'), JSON.stringify(self.hashes), {}, (err) => {
                    if(err){
                      self.emit('error', 'ev', err)
                    } else {
                      self.emit('ev', 'saved hashes')
                    }
                  })
                  fs.writeFile(path.join(self.dir, 'relays.txt'), JSON.stringify(self.relays), {}, (err) => {
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
                res.statusCode = 200
                const ih = req.url.replace('/sub/', '')
                const testHash = crypto.createHash('sha1').update(ih).digest('hex')
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
                  fs.writeFile(path.join(self.dir, 'hashes.txt'), JSON.stringify(self.hashes), {}, (err) => {
                    if(err){
                      self.emit('error', 'ev', err)
                    } else {
                      self.emit('ev', 'saved hashes')
                    }
                  })
                  fs.writeFile(path.join(self.dir, 'relays.txt'), JSON.stringify(self.relays), {}, (err) => {
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
}