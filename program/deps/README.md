# Preloaded programs

`mpl_core.so` is the Metaplex Core program
(`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`), dumped from mainnet-beta so
`scripts/wsl-localnet.sh` (the world's validator and the test suite's) can
preload it with `--bpf-program`. Instar creates one Core collection per world
and one Core asset per larva through CPI, so the program has to exist on any
validator the world runs against; devnet and mainnet-beta already have it.

| | |
| --- | --- |
| dumped | 2026-09-13T05:18:03Z, `solana program dump -u m CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d program/deps/mpl_core.so` (solana-cli 4.2.1) |
| on-chain program data | `9ZC25KLUrfgSoFVgjE1rrydZBbZns58UXi8A8ZhTdGfr`, last deployed in slot 444040451, 848320 bytes |
| upgrade authority (mainnet) | `bfQVv6niKVgEURYqQ1beJmiEQQN7MrvLRvk3mZGFubb` |
| sha256 of `mpl_core.so` | `96fa631a61234766afa538437c5166c628100dbc70e5c3ddb2f306d5dc5a8ba5` |

To refresh after a Core upgrade, run `scripts/wsl-dump-mpl-core.sh` and update
this table from its output.
