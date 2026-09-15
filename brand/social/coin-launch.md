# $INSTAR launch pack

Paste these into pump.fun. The one field that matters is **creator**.

| field | value |
|---|---|
| name | `Instar` |
| ticker | `INSTAR` |
| image | `brand/card-1080.png` (or `brand/pfp-1024.png` for a plain roundel) |
| website | `https://instarcage.com/coin.html` |
| twitter | `https://x.com/InstarCage` |
| **creator / fee recipient** | `9nZk5qGRCoFBGfqBJxFRndRmPYpq9fF9ukU89zzyHWNM` |
| holder rewards | **off** |
| cashback | **off** |
| Mayhem mode | **off** |
| initial buy | optional, small; whatever the launch wallet buys it holds as a trader |

Description (≤ 500 chars, plain, no promises):

> The coin that feeds the Instar cage: a live world of fruit flies on Solana, each driven by every neuron of the Janelia MaleCNS connectome, every fly an NFT, every epoch hashed to the chain. This coin's creator fees are claimed by the world and paid into the cage: half raises how many flies it can hold, half pays the flies that live well. It confers nothing else. No governance, no access, no share of any fly. instarcage.com

Why the toggles are off: holder rewards make the `["holder-rewards", mint]` PDA the creator forever, so no fee ever reaches the cage; cashback rebates part of the fee to traders; Mayhem changes the curve. All three take income away from the cage and none can be undone after launch.

If the UI does not let you set a creator other than the connected wallet, connect the fee keypair itself (import `.keys/mainnet/fee.json` into the launch wallet; it holds 0.05 SOL, enough to pay the create transaction ~0.02 SOL, then top it back up), or launch through `create_v2` with `creator` as an argument (docs/COIN.md §1).

## After launch

Send the mint address. Then:

```
INSTAR_COIN_MINT=<mint> npm run preflight      # confirms the curve's creator is the fee keypair
railway variables --set INSTAR_COIN_MINT=<mint> && npm run deploy:railway
npx tsx scripts/fees.mts status               # vaults, pool, last claim
```

The world then claims creator fees ahead of every ten-minute sweep and funds them into the cage (`fund`, 50/50). The coin page and `/api/config` name the mint automatically; the poster's coin post reads it too.
