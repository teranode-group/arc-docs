# **ARC** - Authoritative Response Component - v1.5.15
> Transaction processor for Bitcoin

**ARC** is a multi-layer transaction processor for Bitcoin that keeps track of the life cycle of a transaction as it is processed by the Bitcoin network. Next to the mining status of a transaction, ARC also keeps track of the various states that a
transaction can be in, such as `ANNOUNCED_TO_NETWORK`, `SEEN_IN_ORPHAN_MEMPOOL`, `SENT_TO_NETWORK`, `SEEN_ON_NETWORK`, `MINED`, `REJECTED`, etc.

Unlike other transaction processors, ARC broadcasts all transactions on the p2p network, and does not rely on the rpc interface of a single Bitcoin node. This makes it possible for ARC to connect and broadcast to any number of nodes, as many as are desired. In the future, ARC will be also able to send transactions using ipv6 multicast, which will make it possible to connect to a large number of nodes without incurring large bandwidth costs.
