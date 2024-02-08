# bittorrent-relay

We love p2p and we would love to bring the p2p way of doing things to browsers. Browsers can already do p2p connections using webrtc but webrtc connections needs to be initiated using a signaling server. So while browser can have p2p connections using webrtc, that initial signaling server can still have issues. Now think about if your website or service gets very popular, the signaling server may be overloaded with too many connections because of the high traffic and performance might go down if not out right crashing. If we can create swarms of webtorrent trackers, then it creates redunduncy. If 1 tracker goes down, then a browser client can use another tracker in this tracker swarm to connect to other browser clients. If 1 tracker doesn't work, you can see the list of other trackers in the swarm and connect to one of those trackers.

some info
* This repo uses bittorrent-dht package - this connects us to other trackers using the bittorrent dht (distributed hash table, a distributed-trackerless way to connect to other peers)
* You must have a server

how it works
1. bittorrent-relay creates a SHA1 hash of a given "infohash" and connects to other nodes who are sharing that same SHA1 hash.
2. once bittorrent-relay connects to these other nodes, it shares tracker information with each other such as url.
3. nodes are then able to make a list of other trackers sharing the same SHA1 hash, and now the list of trackers can be shared and given to regular browser peers
4. bittorrent-relay also uses websockets to share system usage with each node that way a node can see which other nodes are healthy and fresh

to-do
1. finish and improve ways nodes can share system usage data
2. complete the feature to enable users to add other services like gundb

we use the following

[bittorrent-dht](https://github.com/webtorrent/bittorrent-dht) - gives us the ability to connect to other nodes in a distributed (non-centralized) way

[bittorrent-tracker](https://github.com/webtorrent/bittorrent-tracker) - this repo is based on bittorent-tracker (we made changes to it)

TLDR: Instead of using 1 centralized tracker, we connect multiple trackers into a swarm, that way we can use other trackers in case 1 tracker is out of service.
