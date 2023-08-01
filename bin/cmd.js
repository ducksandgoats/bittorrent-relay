#!/usr/bin/env node

import minimist from 'minimist'
import {Server} from '../index.js'
import path from 'path'
import fs from 'fs'

const argv = minimist(process.argv.slice(2), {
  alias: {
    h: 'help',
    v: 'version'
  },
  boolean: [
    'help',
    // 'turnon',
    // 'turnoff',
    'trust-proxy',
    'version',
  ],
  string: [
    'domain',
    'dht-host',
    'tracker-host',
    'host',
    'hashes',
    'key'
  ],
  default: {
    'dht-port': 16881,
    'tracker-port': 16969,
    'dht-host': '0.0.0.0',
    'tracker-host': '0.0.0.0',
    'port': 16969,
    'host': '0.0.0.0',
    'announce-timer': 10 * 60 * 1000,
    'relay-timer': 5 * 60 * 1000,
    'timer': 1 * 60 * 1000,
    'domain': '',
    'trust-proxy': null,
    'auth': null,
    'dir': path.join(process.cwd(), 'dir'),
    'hashes': 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
    'extend-relay': null,
    'extend-handler': null,
    'key': null
  }
})

if (argv.version) {
  console.log(require('../package.json').version)
  process.exit(0)
}

if (argv.help) {
  console.log((() => {
  /*
  bittorrent-tracker - Start a bittorrent tracker server

  Usage:
    bittorrent-tracker [OPTIONS]

  If no --http, --udp, or --ws option is supplied, all tracker types will be started.

  Options:
    -p, --port [number]           change the port [default: 8000]
        --http-hostname [string]  change the http server hostname [default: '::']
        --udp-hostname [string]   change the udp hostname [default: '0.0.0.0']
        --udp6-hostname [string]  change the udp6 hostname [default: '::']
        --trust-proxy             trust 'x-forwarded-for' header from reverse proxy
        --interval                client announce interval (ms) [default: 600000]
        --http                    enable http server
        --udp                     enable udp server
        --ws                      enable websocket server
        --stats                   enable web-based statistics (default: true)
    -q, --quiet                   only show error output
    -s, --silent                  show no output
    -v, --version                 print the current version

  */
  }).toString().split(/\n/).slice(2, -2).join('\n'))
  process.exit(0)
}

if(!fs.existsSync(argv['dir'])){
  fs.mkdirSync(argv['dir'], {recursive: true})
}

const server = new Server({
  announceTimer: argv['announce-timer'],
  relayTimer: argv['relay-timer'],
  timer: argv['timer'],
  trustProxy: argv['trust-proxy'],
  domain: argv['domain'],
  dhtPort: argv['dht-port'],
  trackerPort: argv['tracker-port'],
  dhtHost: argv['dht-host'],
  trackerHost: argv['tracker-host'],
  auth: argv['auth'],
  dir: argv['dir'],
  host: argv['host'],
  port: argv['port'],
  hashes: argv['hashes'].split(',').filter(Boolean),
  extendRelay: argv['extend-relay'],
  extendHandler: argv['extend-handler'],
  key: argv['key']
})

server.on('listening', (which) => {
  console.log('listening', which)
})

server.on('ev', (e) => {
  console.log(e)
})

server.on('error', (which, err) => {
  console.error('close', which, err)
})

server.on('close', (which) => {
  console.log('close', which)
})

server.turnOn(() => {
  console.log('turned on')
})