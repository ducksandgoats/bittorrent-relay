#!/usr/bin/env node

import minimist from 'minimist'
import Relay from '../index.js'

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
    'tracker-host',
    'dht-host'
  ],
  default: {
    'dht-port': 16881,
    'tracker-port': 16969,
    'announce-timer': 10 * 60 * 1000,
    'relay-timer': 5 * 60 * 1000,
    'timer': 1 * 60 * 1000,
    'dht-host': '0.0.0.0',
    'tracker-host': '0.0.0.0',
    'domain': '',
    'trust-proxy': null
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

const relay = new Relay({
  announceTimer: argv['announce-timer'],
  relayTimer: argv['relay-timer'],
  timer: argv['timer'],
  trustProxy: argv['trust-proxy'],
  domain: argv['domain'],
  dhtPort: argv['dht-port'],
  trackerPort: argv['tracker-port'],
  dhtHost: argv['dht-host'],
  trackerHost: argv['tracker-host']
})

relay.on('listening', (which) => {
  console.log('listening', which)
})

relay.on('error', (which, err) => {
  console.error('close', which, err)
})

relay.on('close', (which) => {
  console.log('close', which)
})

relay.tunrOn(() => {
  console.log('turned on')
})