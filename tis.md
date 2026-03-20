# Teranode Infrastructure Services ARC instance

Teranode Infrastructure Services operates an ARC instance for public use. It provides the following URLs
- https://arc.taal.com/v1 (mainnet)
- https://arc-test.taal.com/v1 (testnet)

## API Key requirement

All requests to ARC must be authenticated using an API key except the policy endpoint <a href="api.html#/Arc/GET%20policy" target="_self">/v1/policy</a>.

API Keys can be created on the [Teranode platform](https://platform.teranode.group/).

## Configuration

### Data retention

ARC instance stores transaction data no longer than 2 days (see section [Data storage](arc-docu.md#data-storage))

### Rejection of stuck transactions

As explained in section [Rejection of stuck transactions](arc-docu.md#rejection-of-stuck-transactions) `metamorph` has a feature to detect stuck transactions and transition them to `REJECTED` status.

Transactions transition to status `REJECTED` if they were not received at least **20 min** or the time passed since **3 blocks** were mined after last request.

This feature is currently enabled for statuses
- `SENT_TO_NETWORK`
- `SEEN_ON_NETWORK`
