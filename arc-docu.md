# Documentation

The ARC design decouples the core functions of a transaction processor and encapsulates them as microservices with the ability to scale horizontally adaptively. Interaction between microservices is decoupled using asynchronous messaging where possible.

ARC consists of multiple core microservices: [API](#API), [Metamorph](#Metamorph), [Callbacker](#Callbacker), [BlockTx](#BlockTx) and [Message-Aggregator](#Message-Aggregator), which are all described below.

All the microservices are designed to be horizontally scalable and can be deployed on a single machine or on multiple machines. Each one has been programmed with a store interface. Currently, the default store is PostgreSQL, but any database that implements the store interface could be used.

![Building block diagram](building_block_diagram.drawio.svg)

## Transaction lifecycle

The ARC architecture has been designed to assist in the management of the transaction lifecycle, enabling better tracking each transaction status, reissuing transactions until they are seen by the network and notifying the issuer of relevant status changes. This ARC feature allows clients and bitcoin wallets to be lighter and more efficient in their mission.

ARC is a transaction processor for Bitcoin that keeps track a transaction's like cycle as it is processed by the Bitcoin network. Next to the mining status of a transaction, ARC also keeps track of the various states that a transaction can be in, such as `ANNOUNCED_TO_NETWORK`, `SEEN_IN_ORPHAN_MEMPOOL`, `SENT_TO_NETWORK`, `SEEN_ON_NETWORK`, `MINED`, `REJECTED`, etc.

If a transaction is not at least `SEEN_ON_NETWORK` within a certain time period (60 seconds by default), ARC will re-send the transaction to the Bitcoin network. ARC also monitors the Bitcoin network for transaction and block messages, and will notify the client when a transaction has been mined, or rejected.

```mermaid
stateDiagram-v2
    state UNKNOWN
    state QUEUED
    state RECEIVED
    state STORED
    state ANNOUNCED_TO_NETWORK
    state ERROR
    state REQUESTED_BY_NETWORK
    state SENT_TO_NETWORK
    state ACCEPTED_BY_NETWORK
    state SEEN_IN_ORPHAN_MEMPOOL
    state DOUBLE_SPEND_ATTEMPTED
    state SEEN_ON_NETWORK
    state REJECTED
    state MINED
    state MINED_IN_STALE_BLOCK

    [*] --> UNKNOWN
    UNKNOWN --> ERROR: Transaction validation failed
    UNKNOWN --> RECEIVED: Transaction validation passed
    UNKNOWN --> QUEUED: Transaction could not be transmitted\n to metamorph within timeout duration
    QUEUED --> RECEIVED: Transaction received by metamorph
    RECEIVED --> STORED: Transaction has been stored in ARC
    STORED --> ANNOUNCED_TO_NETWORK: Transaction ID has been announced to\n P2P network via an INV message
    ANNOUNCED_TO_NETWORK --> REQUESTED_BY_NETWORK: Peer has requested the transaction\n with a GETDATA message
    REQUESTED_BY_NETWORK --> SENT_TO_NETWORK: Transaction has been sent to peer
    SENT_TO_NETWORK --> ACCEPTED_BY_NETWORK: The transaction has been accepted\n by peer on the ZMQ interface
    SENT_TO_NETWORK --> DOUBLE_SPEND_ATTEMPTED: This transaction has competing transactions
    SENT_TO_NETWORK --> REJECTED: Peer has sent a REJECT message
    ACCEPTED_BY_NETWORK --> SEEN_ON_NETWORK: ARC has received Transaction ID\n announcement from another peer
    ACCEPTED_BY_NETWORK --> SEEN_IN_ORPHAN_MEMPOOL: Peer has sent a 'missing inputs' message
    SEEN_IN_ORPHAN_MEMPOOL --> SEEN_ON_NETWORK: All parent transactions\n have been received by peer
    SEEN_ON_NETWORK --> MINED: Transaction ID was included in a BLOCK message
    SEEN_ON_NETWORK --> DOUBLE_SPEND_ATTEMPTED: A competing transactions entered the mempool
    DOUBLE_SPEND_ATTEMPTED --> MINED: This transaction was accepted and mined
    DOUBLE_SPEND_ATTEMPTED --> REJECTED: This transaction was rejected in favor\n of one of the competing transactions
    MINED --> MINED_IN_STALE_BLOCK: This transaction was mined in a block that became stale after reorg
    MINED --> [*]
```
### Transaction rejection reasons

There are multiple possible reasons why a transaction might get status `REJECTED` in ARC by the Bitcoin network.

Here is a list of possible reasons:
- A transaction had status `DOUBLE_SPEND_ATTEMPTED` and one of the competing transactions has been mined
- There was a zmq message on topic `discardedfrommempool` for that transaction
- A p2p message reject message was received for that transaction
- A transaction remained in an unmined state for a certain time (see section [Rejection of pending transactions](#rejection-of-pending-transactions))

## Microservices

### API

API is the REST API microservice for interacting with ARC. See the <a href="api.html" target="_self">API documentation</a> for more information.

The API takes care of validation and sending transactions to Metamorph. The API talks to one or more Metamorph instances using client-based, round-robin load balancing.

The `X-MaxTimeout` header determines the maximum number of seconds the system will wait for new transaction statuses before the response is returned. The default timeout is 5 seconds, with a maximum value of 30 seconds.

#### Validation

The API is the first component of ARC and therefore the one that by design derives a benefit for ARC performing a preliminar validation of transactions thanks to the use of the [extended transaction formats](#extended-format-ef-and-background-evaluation-extended-format-beef).

However, sending transactions in classic format is supported through the ARC API.

When possible, the API is responsible for rejecting transactions that would be unacceptable to the Bitcoin network.

Depending on given validation options provided as request headers a different logic applies to the validtion. More details can be found in the section about [Validation options](#validation-options) and <a href="api.html" target="_self">API documentation</a>.

#### Callbacks

The client can register to receive callbacks with information about the statuses of submitted transactions. To do this, the client must include the `X-CallbackUrl` header in their request. Once registered, the ARC will send a `POST` request to the URL specified in the header, with the transaction ID included in the request body.

If the client wants to secure its callback endpoint, ARC supports Bearer token authorization. A callback token can be provided by adding the `X-CallbackToken: <your callback token>` header to the request.

By default, ARC sends a single callback per request, but the client can modify this behavior by including the `X-CallbackBatch: true` header. All callbacks related to transactions submitted with this header will be sent in batches (with a maximum batch size of `50` callbacks).

By default, callbacks are triggered when the submitted transaction reaches the status `REJECTED` or `MINED`. If the client wishes to receive additional intermediate status updates—such (e.g. `SEEN_IN_ORPHAN_MEMPOOL` or `SEEN_ON_NETWORK`) the `X-FullStatusUpdates` header must be set to true. For more details, refer to the <a href="api.html" target="_self">API documentation</a>.

If a transaction is submitted multiple times with differing callback URL or token, then callbacks will then be sent to each callback URL with its specified token.

For more details on how callbacks work, see the [Callbacker](#Callbacker) section.

### Metamorph

Metamorph is a microservice that is responsible for processing. After it receives transactions from the API service, it stores them in the database and broadcasts them to the Bitcoin network. Once broadcasted Metamorph takes care of rebroadcasting transactions if they haven't transitioned to status `SEEN_ON_NETWORK` by the network within a certain time period (60 seconds by default). Metamorph updates the status of each transaction as they go through the [transaction lifecycle](#transaction-lifecycle).

#### Rejection of pending transactions

It can happen for various reasons that a transaction is stuck in an intermediate state like `ANNOUNCED_TO_NETWORK`, `SENT_TO_NETWORK` or `SEEN_ON_NETWORK` for a long time.

For example, a transaction can get remain in status `SEEN_ON_NETWORK` or `SENT_TO_NETWORK` if it had been mined previously in a block but that block was mined a longer time a go than the data retention period of the ARC instance (see [Data storage](#data-storage)).

Metamorph has a mechanism that will automatically set a transaction status to `REJECTED` under certain condtions. For a specified list of transaction statuses, Metamorph will request the transaction from different mempools. If Metamorph didn't receive the transaction during a specified time period, and if during that time period a specified number of blocks has been mined, then the transaction status will transition to `REJECTED`. The mechanism can be configured by the operator of ARC and can also be disabled entirely.

```plantuml
@startuml
hide footbox
skinparam ParticipantPadding 15
skinparam BoxPadding 10


box metamorph
    participant worker
    database store
    participant "peer\nserver" as peer
end box


database "bitcoin\nnetwork" as bsv

title Reject pending transactions

worker -> store ++: get pending txs
  return

  loop for each pending tx
    worker -> peer ++: request data

      peer -> bsv ++: GET TX
        return raw tx
    else raw tx returned
    return raw tx
    worker -> store: Update confirmed
    else raw tx not returned for specified time and specified nr of blocks mined
    
    worker -> store: Update REJECTED
  end

@enduml
```

### Callbacker

The Callbacker is a microservice responsible for handling all registered callbacks. It sends `POST` requests to the specified URL, including a `Bearer token` in the `Authorization header` when required, and supports sending callbacks in two distinct ways: either as an individual callback or as a batch of callbacks. When sending a single callback, the service makes a call with just one callback object. Callbacks registered as batchable are sent together in a single request (with a maximum of `50` callbacks per request). By default, batched callbacks are sent at `5s` intervals, though this is configurable.

The specification of the callback objects, along with examples, can be found <a href="api.html#model-Callback" target="_self">single callback</a> and <a href="api.html#model-BatchedCallbacks" target="_self">batched callbacks</a> in the <a href="api.html" target="_self">API Documentation</a>.

To prevent DDoS attacks on callback receivers, each Callbacker service instance sends callbacks to the specified URLs a limited number of times. This limit is configurable and defaults to a maximum of `10` attempts per callback.

The Callbacker handles request retries and treats any HTTP status code outside the range of `200–299` as a failure. If the receiver fails to return a success status, the callback will be retried later. Callbacker sends the status updates in chronological order per transaction. If a callback fails, Callbacker will resend the same callback until the callback is sent successfully, or the maximum number of retries is reached. There is also an expiration time for callbacks, which is configurable and defaults to 24 hours. Callbacks that have not been successfully sent during the expiration time are no longer sent.

Multiple instances of Callbacker can run in parallel.

### Message-Aggregator

Message aggregator is a microservice service that connects to the SV nodes ZMQ server and listens to the topics `hashtx2`, `invalidtx`, `discardedfrommempool`. When any of those messages are received, Message-Aggregator passes those messages to Metamorph after they have been deduplicated. A message received on the `hashtx2` topic will update the respective transaction ID to `ACCEPTED_TO_NETWORK`. A message received on the `discardedfrommempool` topic will do the same but for the `REJECTED` status. If a message on the `invalidtx` topic the respective transaction could be updated to `SEEN_IN_ORPHAN_MEMPOOL` or `DOUBLE_SPEND_ATTETMPED` depending on additional message properties.

### BlockTx

BlockTx is a microservice that is responsible for processing blocks mined on the Bitcoin network, handling chain reorganizations ([reorgs](#chain-reorg)) and for propagating the status of transactions to each Metamorph that has subscribed to this service.

As an incoming block is processed by BlockTx, Metamorph is notified about mined transactions. BlockTx does not store the raw transactions but instead stores only the transaction IDs and the block height in which they were mined. Metamorph is responsible for storing the transaction data.

BlockTx also stores information about mined blocks, such as the Merkle roots, which are used in [BEEF validation process](#extended-format-ef-and-background-evaluation-extended-format-beef).

Multiple instances of BlockTx can run in parallel. BlockTx makes sure that always only one instance processes a block to avoid duplicate work. This can be useful at times when large blocks are mined.

### Data storage

The services Metamorph, BlockTx and Callbacker use a data storage to persist state. The default database is PostgreSQL. The data does not necessarily be stored forever. Each of these services, respective gRPC functions are provided for deleting data stored prior to a specified number of days. The operator of ARC can set their own retention period by deleting data on a regular basis using these functions.

Additionally, there is a cache data store used in Metamorph to store the status of transactions that have been submitted to the API. This cache allows filtering out inventory messages from the p2p network which are irrelevant to ARC and ensures that status updates on the DB are only performed for transactions that had been submitted to ARC. The cache is implemented as a Redis instance.

## Extended Format (EF)

For optimal performance, ARC uses custom formats for transactions.

The first format is called the extended format, and is a superset of the raw transaction format. The extended format includes the satoshis and scriptPubKey for each input, which makes it possible for ARC to validate the transaction without having to download the parent transactions. In most cases the sender already has all the information from the parent transaction, as this is needed to sign the transaction. Please find more details in [BIP-239](BIP-239.md). The Extended Format has been described in detail in [BRC-30](https://bsv.brc.dev/transactions/0030).

The only check that cannot be done on a transaction in the extended format is the check for double spends. This can only be done by downloading the parent transactions, or by querying a utxo store. At this moment, the utxo check is performed in the Bitcoin node when a transaction is sent to the network.

### Extended Formats efficiency

The following diagrams show the difference between validating a transaction in the standard format, the Extended Format:

#### Standard format flow

```plantuml
@startuml
hide footbox
skinparam ParticipantPadding 15
skinparam BoxPadding 100

actor "client" as tx


box ARC
participant api
participant validator
participant metamorph
database "bitcoin" as bsv
end box

title Submit transaction (standard format)

tx -> tx: create tx
tx -> tx: <font color=red><b>add utxos</b></font>
tx -> tx: add outputs
tx -> tx: sign tx

tx -> api ++: raw tx (standard)

  loop for each input
    api -> bsv ++: <font color=red><b>get utxos (RPC)</b></font>
    return previous tx <i>or Missing Inputs</i>
  end

  api -> validator ++: validate tx
  return ok

  api -> metamorph ++: send tx
    metamorph -> bsv
  return status

return status

@enduml
```
For each request ARC receives in standard format, it must request the utxos from the Bitcoin node. This is a slow process, as it requires a round trip to the Bitcoin node for each input.

For this reason it is expected that transactions come in an extended format or BEEF. Transactions in standard format require a pretreatment to convert each tx into extended format to pass through the ARC pipeline.

That pretreatment detracts from the expected efficiency of the process because it requires extra requests to the Bitcoin network. Therefore, it is expected that the trend will be to use the EF or BEEF, which may be the only supported formats in future.

#### Extended format flow

```plantuml
@startuml
hide footbox
skinparam ParticipantPadding 15
skinparam BoxPadding 100

actor "client" as tx


box ARC
participant api
participant validator
participant metamorph
database "bitcoin" as bsv
end box

title Submit transaction (extended format)

tx -> tx: create tx
tx -> tx: add utxos
tx -> tx: add outputs
tx -> tx: sign tx

tx -> api ++: raw tx (extended)
  api -> validator ++: validate tx
  return ok

  api -> metamorph ++: send tx
    metamorph -> bsv
  return status

return status

@enduml
```
In contrast, the extended format allows the API to perform a preliminary validation and rule out malformed transactions by reviewing the transaction data provided in the extended fashion. Obviously, double spending (for example) cannot be checked without an updated utxo set, and it is assumed that the API does not have this data. Therefore, the "validator" sub-function within the API filters as much as it can to reduce spurious transactions passing through the pipeline but leaves others for the bitcoin nodes themselves.

This [validation](#validation) takes place in the ARC API microservice. The actual utxos are left to be checked by the Bitcoin node itself, like it would do anyway, regardless of where the transaction is coming from. With this process flow we save the node from having to lookup and send the input utxos to the ARC API, which could be slow under heavy load.

## Background Evaluation Extended Format (BEEF)

The second format is called Background Evaluation Extended Format, or BEEF, in short. BEEF was created to enable and facilitate Simplified Payment Verification ([SPV](https://bsv.brc.dev/transactions/0067)) when sending transactions between peers which allows validation of transactions, the inputs of which may not yet be mined. Although this format is mainly used in peer-to-peer transactions, a peer ultimately has to submit the transaction to the nodes, and to help with that, Arc not only accepts that format, but also performs the SPV.
The Background Evaluation Extended Format has been described in detail in [BRC-62](https://bsv.brc.dev/transactions/0062).

BEEF includes the transaction which constitutes the payment, as well as transactions whose outputs are used as inputs to the payment transaction (parent transactions) with their corresponding Merkle paths in the form of [BUMP](https://bsv.brc.dev/transactions/0074). In cases where the parent transaction is not yet mined, each ancestral transaction is included until the ancestor transaction is mined and has a corresponding Merkle path.

Arc validates each unmined transaction in BEEF in the same way it does an Extended Transaction. For each transaction with Merkle path (BUMP), the Merkle root is calculated and verified against a [block-headers-service](https://github.com/bsv-blockchain/block-headers-service) or optionally [BlockTx](#BlockTx) which will prove that the Merkle roots provided are all part of block headers within the longest chain. Configuring ARC to use block-headers-service is recommended as it keeps all the block headers back to the genesis block while blocktx doesn't necessarily keep all the block headers to save storage space.

With the successful adoption of Bitcoin ARC, these formats should establish themselves as the new standard of interchange between wallets and non-mining nodes on the network.

### BEEF flow

```plantuml
@startuml
hide footbox
skinparam ParticipantPadding 15
skinparam BoxPadding 100

actor "client" as tx


box ARC
participant api
participant validator
participant blocktx
participant metamorph
end box

database "block-headers-\nservice" as bhs
database "bitcoin" as bsv

title Submit transaction (BEEF)

tx -> tx: prepare tx in BEEF

tx -> api ++: raw tx (BEEF)
  api -> validator ++: validate unmined txs
  return ok

  alt block-headers-service used as block headers source 
     api -> bhs ++: verify Merkle roots from BUMPs
     return ok
  else blocktx used as block headers source
     api -> blocktx ++: verify Merkle roots from BUMPs
     return ok
  end

  api -> metamorph ++: send tx
    metamorph -> bsv
  return status

return status

@enduml
```

BEEF flow is very similar to Extended Format flow, with an additional step of Merkle roots verification in a call to the block-headers-service or blocktx. This step makes the whole validation process more thorough and allows for validation of transactions whose inputs are not yet mined without recursively asking the nodes for them.

## Process flow diagrams

The following diagram shows the process of how a transaction goes through the different statuses of the transaction lifecycle before it gets mined.

```plantuml
@startuml
hide footbox
skinparam ParticipantPadding 15
skinparam BoxPadding 10

actor "client" as tx

box api server
    participant handler
    participant validator
end box

box metamorph
    participant grpc
    participant worker
    database store
    participant "peer\nserver" as peer
end box

box msg-aggregator
    participant "zmq\nlistener" as zmq
end box

database "bitcoin\nnetwork" as bsv

title Submit transaction via P2P

tx -> handler ++: extended\nraw tx

    handler -> validator ++: tx
    return success

    handler -> grpc ++: tx
        grpc -> worker ++: tx
            worker -> store++: tx
        return STORED
        worker --> grpc: STORED

        worker -> peer: txid
        peer -> bsv: INV txid
        peer -> worker: ANNOUNCED

        worker -> store: ANNOUNCED


        bsv -> peer++: GETDATA txid
            peer -> worker: REQUESTED
            worker -> store: REQUESTED
            peer -> store ++ : get tx
            return raw tx

        return tx

        peer -> worker: SENT

        worker -> store: SENT



        bsv -> zmq: txid
        zmq -> worker: ACCEPTED

        worker -> store: ACCEPTED


        bsv -> peer: INV txid
        peer -> worker: SEEN
        worker -> store: SEEN

    return status

    grpc -> grpc: wait for\nspecified status\nor TIMEOUT
    return last status

return last status

@enduml

```

The following diagram shows the process of how a transaction finally gets updated to status `MINED`.

```plantuml
@startuml
hide footbox
skinparam ParticipantPadding 15
skinparam BoxPadding 10

box metamorph
    participant grpc
    participant worker
    database store
    participant "peer\nhandler" as mpeer
end box

box message queue
    participant "queue" as queue
end box

box blocktx
    participant "worker" as blocktx
    database blockstore
    participant "peer\nhandler" as peer
end box

database "bitcoin\nnetwork" as bsv

title Process block via P2P

bsv -> peer++: BLOCK blockhash

peer -> blocktx++: blockhash
    blocktx -> peer: get block
    peer -> bsv: GETDATA blockhash
    bsv -> peer: BLOCK block
peer -> blocktx--: block

blocktx -> blockstore: block
worker -> queue++: subscribe
blocktx -> queue--: publish txs
queue -> worker--: txs
worker -> store: mark txs mined

@enduml
```

## Outcome in different scenarios

### Double spending

In a following situation:
> Transaction `A` is submitted to the network. Shortly later, or in exactly the same time, transaction `B` spending one of the same outputs as transaction `A` (double spend) is submitted to ARC.

These things will happen:
1. Both transaction `A` and `B` will receive status `DOUBLE_SPEND_ATTEMPTED`.
    * A callback will be sent for every double spend transaction (provided that `X-FullStatusUpdates` header is set).
    * For each transaction - its competing transactions IDs (hashes) will be returned in the response and/or in the callback.
2. When either transactions `A` or `B` is mined, the other will be rejected. The mined transaction gets status `MINED` and the other gets status `REJECTED`.
    * Querying ARC for `MINED` transaction `A` will return an extra information that this transaction was previously a double spend attempt.
    * Querying ARC for `REJECTED` transaction `B` will return "double spend attempted" information as rejection reason.

The same applies to all transactions, if more than two transactions are trying to spend the same UTXO.

#### Double Spend flow - Examples

##### Scenario 1
> Transaction `A` is submitted to the network NOT through Arc.
> A short moment later, transaction `B` spending the same output is submitted to Arc.
> Later, transaction `A` is mined.

Outcome:
1. A response to submitting transaction `B` will include `DOUBLE_SPEND_ATTEMPTED` status and an ID (hash) of transaction `A` as a competing transaction.
2. After transaction `A` is mined, transaction `B` will be rejected and receive status `REJECTED`.
3. If callback URL is specified - the callback with status `REJECTED` and information about rejection reason (double spend) will be sent for transaction `B`.


##### Scenario 2
> Transaction `A` is submitted to the network through Arc.
> A short moment later, transaction `B` spending the same output is submitted to Arc.
> Later, transaction `A` is mined.

Outcome:
1. A response for submitting transaction `A` will include `SEEN_ON_NETWORK` status without any information about competing transactions.
2. A response for submitting transaction `B` will include `DOUBLE_SPEND_ATTEMPTED` status and an ID (hash) of transaction `A` as a competing transaction.
    * Transaction `A` status will be internally changed to `DOUBLE_SPEND_ATTEMPTED`.
    * If callback URL is specified for transaction `A` - the callback with status `DOUBLE_SPEND_ATTEMPTED` and an ID (hash) of transaction `B` as a competing transaction will be sent for transaction `A`.
3. Querying for transaction `A` will now also result in `DOUBLE_SPEND_ATTEMPTED` status and an ID (hash) of transaction `B` as a competing transaction.
4. After transaction `A` is mined, it will receive status `MINED`.
    * If callback URL is specified for transaction `A` - a callback with status `MINED` and an extra information that this transactions was previously a double spend attempt will be sent.
5. Transaction `B` will be rejected and receive status `REJECTED`. The callback will be sent with an information.
    * If callback URL is specified for transaction `B` - a callback with status `REJECTED` and an extra information that this transactions was a double spend attempt will be sent.
6. Querying for transaction `A` will now also result in `MINED` status and an extra information that this transactions was previously a double spend attempt.
7. Querying for transaction `B` will now also result in `REJECTED` status and an extra information that this transactions was a double spend attempt.


##### Scenario 3
> Transaction `A` is submitted outside of Arc to a node that is not directly connected to Arc.
> Transaction `B` spending the same output is submitted to Arc at **exactly** the same moment.

Outcome:
1. Submitting transaction `B` will initially result in status `SEEN_ON_NETWORK` and no competing transactions.
2. Status for transaction `B` will be changed to `DOUBLE_SPEND_ATTEMPTED` as soon as nodes share transactions `A` and `B` with each other, which usually is a matter of seconds maximum.
    * If callback URL is specified for transaction `B` - the callback with status `DOUBLE_SPEND_ATTEMPTED` and an ID (hash) of transaction `A` as a competing transaction will be sent for transaction `B`.
3. If transaction `A` will be mined, transaction `B` will receive status `REJECTED` and a callback will be sent (if callback URL is set).

#### Edge case
If transactions `A` and `B` are submitted at exactly the same time to different nodes through ARC, they both may initially receive status `SEEN_ON_NETWORK`. The status for both will be updated to `DOUBLE_SPEND_ATTEMPTED` as soon as nodes will share these transactions with each other and therefore realise it's a double spend attempt, which is usually instantaneous.

The chance of this situation happening is extremely low when submitting transactions through Arc.


### Multiple submissions to the same ARC instance

A transaction is submitted to the same ARC instance twice

Expected outcome:
* At the second submission ARC simply returns the current status in the response. Changed or updated request headers are ignored except for the callback URL and token. If the callback URL and token differ, then callbacks will then be sent to each callback URL with its specified token.

### Multiple submissions to ARC and other transaction processors

A transaction has been submitted to the network by any other means than a specific ARC instance. The same transaction is additionally submitted to ARC

#### Transaction has already been mined

Expected outcome
* ARC returns a response with the status `ANNOUNCED_TO_NETWORK`
* The status will switch to `MINED`, including the respective block information and Merkle path.

#### Transaction has not yet been mined

Expected outcome
* ARC responds with status `ANNOUNCED_TO_NETWORK` or `SEEN_ON_NETWORK`
* At latest a couple of minutes later the status will switch to `SEEN_ON_NETWORK`

### Chain reorg

A chain reorganization (chain reorg) occurs when the blockchain switches its primary chain of blocks to a different branch, typically because a previously stale chain (fork) has accumulated more chainwork than the current longest chain. Chainwork, which represents the cumulative computational effort used to build a chain, is the deciding factor in determining the longest and most valid chain. This process can impact transaction statuses based on their presence in the affected chains.

#### Transaction in both chains
This is the most common scenario. If a transaction is included in both the original longest chain and the stale chain (which becomes the longest), the transition to the new longest chain does not disrupt the transaction's confirmation status.

A new `MINED` callback will be send for that transaction with updated block data (block hash, block height, Merkle path).

#### Transaction in the previously longest chain, but not in the stale chain that becomes longest
When a transaction exists in the original longest chain but not in the stale chain that subsequently becomes the longest, the transaction is effectively removed from the confirmed state of the blockchain.

A callback with status `MINED_IN_STALE_BLOCK` will be sent for that transaction and ARC will rebroadcast that transaction. Because of that process, the transaction may cycle through statuses, such as `SEEN_ON_NETWORK`, again. User should keep in mind that the status `MINED_IN_STALE_BLOCK` **is not final**.

#### Transaction in the stale chain only (without reorg)
When a transaction is present only in the stale chain and not in the original longest chain, it remains unconfirmed, in the `MINED_IN_STALE_BLOCK` state, until the stale chain becomes the longest or the transaction is found in the longest chain.

A callback with status `MINED_IN_STALE_BLOCK` will be sent for that transaction and ARC will rebroadcast that transaction. Because of that process, the transaction may cycle through statuses, such as `SEEN_ON_NETWORK`, again. User should keep in mind that the status `MINED_IN_STALE_BLOCK` **is not final**.

#### Summary table
| Transaction Scenario                 | Callback status after reorg | Extra info / Action                                                                                    |
|--------------------------------------|-----------------------------|--------------------------------------------------------------------------------------------------------|
| In both chains                       | `MINED`                     | Block data (hash, height, Merkle path) will be updated in the callback                                 |
| In longest chain, not in stale chain | `MINED_IN_STALE_BLOCK`      | Transaction will be rebroadcasted and cycle through statuses again until is found in the longest chain |
| In stale chain only (no reorg)       | `MINED_IN_STALE_BLOCK`      | Transaction will be rebroadcasted and cycle through statuses again until is found in the longest chain |

#### Simplified flow diagram
```mermaid
flowchart TD
    A[Incoming new block received from peers] --> B{Block already in DB?}
    B -->|Yes| S((STOP))
    B -->|NO| C[Insert block to DB]
    C --> D["`Assign status to the new block based on a previous block. Status is one of: LONGEST | STALE (fork) | ORPHANED`"]
    D --> E{Switch block.Status}

    E --> F[ORPHANED]
    F --> I[Get orphaned blocks down to non-orphan ancestor]
    I --> J["Accept orphaned blocks into the chain of the non-orphan ancestor (if non-orphan ancestor exists)"]
    J --> K["Perform the steps of the LONGEST or STALE case, depending on which chain was the orphan block accepted to (if any)"]
    K --> Q[Publish MINED transactions to metamorph]

    E --> H[STALE]
    H --> L["`Compare the **chainworks** of the stale chain and the longest chain`"]
    L --> M{Stale chain has greater chainwork?}
    M -->|YES| N["`Perform **reorg**`"]
    N --> O[Mark block from the longest chain as STALE]
    O --> P[Mark blocks from the stale chain as LONGEST]
    P --> Q

    E --> G[LONGEST]
    G --> Q
```

## Validation options

### Force validation

If the `X-ForceValidation` header is set, the tx will be validated regardless of the other header values.

Example usage:
```
X-ForceValidation: true
```

### Cumulative fees validation

The "Cumulative Fee Validation" feature is designed to check if the chain of unmined transactions (submitted transaction and its unmined ancestors) has paid a sufficient amount of fees. This validation is carried out based on a specific HTTP header.

The `X-CumulativeFeeValidation` header must be set to `true` for the validation to be performed.
The `X-SkipFeeValidation` header takes precedence over `X-CumulativeFeeValidation` and causes the fee validation to be skipped.

#### Usage

To use the "Cumulative Fee Validation" feature, you need to send the `X-CumulativeFeeValidation` header with the value set to `true`.

Example usage:
```
X-CumulativeFeeValidation: true
```

##### Special Cases

If the `X-SkipFeeValidation` header is also sent, the fee validation will be skipped even if `X-CumulativeFeeValidation` is set to `true`.

Example usage:
```
X-CumulativeFeeValidation: true
X-SkipFeeValidation: true
```

In this case, the fee validation will not be performed.

#### Examples
##### Example 1: Insufficient Fee Paid by One Ancestor
Transaction t0 has two unmined ancestors t1 and t2.

* t0 has paid a sufficient fee for itself.
* t1 has not paid a sufficient fee.
* t2 has paid a sufficient fee for itself.

###### Validation Result:
The validation will fail because t1 has not paid a sufficient fee and no other transaction cover it.

##### Example 2: All Transactions Paid Their Own Fees
Transaction t0 has two unmined ancestors t1 and t2.

* t0 has paid a sufficient fee.
* t1 has paid a sufficient fee.
* t2 has paid a sufficient fee.

###### Validation Result:
The validation will pass because both t1 and t2 have paid sufficient fees.

##### Example 3: Ancestors Did Not Pay, But Transaction Covers All Fees
Transaction t0 has two unmined ancestors t1 and t2.

* t1 has not paid a sufficient fee.
* t2 has not paid a sufficient fee.
* t0 covers the fees for itself and both t1 and t2.

###### Validation Result:
The validation will pass because t0 covers the cumulative fees for the entire chain, including t1 and t2.

The system performs the fee validation and returns a result indicating that the chain of transactions has sufficient fees.

## Client Libraries

- Typescript: [@bsv/sdk](https://github.com/bsv-blockchain/ts-sdk)
- Go: [go-sdk](https://github.com/bsv-blockchain/go-sdk)
- Python: [py-sdk](https://github.com/bsv-blockchain/py-sdk)

> NOTE: [arc-client-js](https://github.com/bitcoin-sv/arc-client-js) is deprecated.
