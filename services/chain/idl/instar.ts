/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/instar.json`.
 */
export type Instar = {
  "address": "A42YLDRf1WoVVzrkPpkGnvsKpJiN4oZCjHEvo4iMt6Tu",
  "metadata": {
    "name": "instar",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Instar: the on-chain world record for a population of larvae driven by the Winding 2023 larval connectome"
  },
  "instructions": [
    {
      "name": "acceptOperator",
      "discriminator": [
        216,
        185,
        116,
        130,
        254,
        55,
        57,
        128
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "pendingOperator",
          "signer": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "beginWindDown",
      "discriminator": [
        89,
        28,
        134,
        161,
        28,
        9,
        243,
        171
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "signer",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "buy",
      "discriminator": [
        102,
        6,
        61,
        18,
        1,
        218,
        235,
        234
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "parent",
          "docs": [
            "The parent record, for the ancestry royalty. Omitted for a founder;",
            "the seeds prove it is the record `creature.parent_id` names."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "creature.parent_id",
                "account": "creature"
              }
            ]
          }
        },
        {
          "name": "asset",
          "writable": true
        },
        {
          "name": "collection",
          "writable": true
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "price",
          "type": "u64"
        }
      ]
    },
    {
      "name": "buyListed",
      "discriminator": [
        75,
        236,
        50,
        95,
        167,
        79,
        50,
        201
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "asset",
          "writable": true
        },
        {
          "name": "collection",
          "writable": true
        },
        {
          "name": "sellerCredit",
          "docs": [
            "The seller's credit: the keeper who listed the fly."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "creature.listed_by",
                "account": "creature"
              }
            ]
          }
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "price",
          "type": "u64"
        }
      ]
    },
    {
      "name": "closeCredit",
      "discriminator": [
        151,
        225,
        136,
        142,
        221,
        237,
        105,
        183
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "credit",
          "docs": [
            "Any holder's credit, passed by address; no signature, since after",
            "escheat it is empty and the World no longer backs it."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "credit.owner",
                "account": "credit"
              }
            ]
          }
        },
        {
          "name": "recovery",
          "writable": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "closeRecord",
      "discriminator": [
        111,
        192,
        122,
        188,
        38,
        234,
        242,
        249
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "recovery",
          "writable": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "closeWorld",
      "discriminator": [
        250,
        171,
        64,
        179,
        30,
        236,
        152,
        24
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "recovery",
          "writable": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "escheat",
      "discriminator": [
        186,
        108,
        83,
        170,
        7,
        154,
        111,
        219
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "recovery",
          "writable": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "forceSettleCull",
      "discriminator": [
        63,
        215,
        50,
        16,
        221,
        225,
        61,
        60
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "Anyone; only the keeper is paid, so a stranger pressing it just helps."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "asset",
          "writable": true
        },
        {
          "name": "collection",
          "writable": true
        },
        {
          "name": "keeperCredit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "asset.owner",
                "account": "larvaAsset"
              }
            ]
          }
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "fund",
      "discriminator": [
        218,
        188,
        111,
        221,
        152,
        113,
        174,
        7
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "poolBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "heartbeat",
      "discriminator": [
        202,
        104,
        56,
        6,
        240,
        170,
        63,
        134
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "signer": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "initWorld",
      "discriminator": [
        10,
        53,
        110,
        193,
        166,
        122,
        251,
        1
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "writable": true,
          "signer": true
        },
        {
          "name": "collection",
          "docs": [
            "The Core collection every fly will belong to: a fresh keypair the",
            "client generates and signs for, as Core requires of a new account."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "program",
          "address": "A42YLDRf1WoVVzrkPpkGnvsKpJiN4oZCjHEvo4iMt6Tu"
        },
        {
          "name": "programData"
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "recovery",
          "type": "pubkey"
        },
        {
          "name": "collectionUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "list",
      "discriminator": [
        54,
        174,
        193,
        67,
        17,
        41,
        132,
        38
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "asset"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "price",
          "type": "u64"
        }
      ]
    },
    {
      "name": "openOffer",
      "discriminator": [
        118,
        149,
        74,
        202,
        212,
        206,
        207,
        167
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "signer": true,
          "relations": [
            "world"
          ]
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "asset"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "price",
          "type": "u64"
        }
      ]
    },
    {
      "name": "postEpoch",
      "discriminator": [
        45,
        8,
        238,
        205,
        94,
        1,
        200,
        51
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "signer": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": [
        {
          "name": "epoch",
          "type": "u64"
        },
        {
          "name": "tick",
          "type": "u64"
        },
        {
          "name": "stateHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "reclaimVault",
      "discriminator": [
        74,
        24,
        87,
        20,
        107,
        242,
        234,
        72
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "asset",
          "writable": true
        },
        {
          "name": "collection",
          "writable": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "registerBirth",
      "discriminator": [
        132,
        102,
        12,
        76,
        96,
        73,
        238,
        126
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "writable": true,
          "signer": true,
          "relations": [
            "world"
          ]
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "asset",
          "docs": [
            "The fly's Core asset: a fresh keypair the client signs for."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "collection",
          "writable": true
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "parentId",
          "type": "u64"
        },
        {
          "name": "generation",
          "type": "u32"
        },
        {
          "name": "birthTick",
          "type": "u64"
        },
        {
          "name": "genomeHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "uri",
          "type": "string"
        }
      ]
    },
    {
      "name": "requestCull",
      "discriminator": [
        31,
        205,
        161,
        220,
        177,
        52,
        158,
        253
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "asset",
          "writable": true
        },
        {
          "name": "collection",
          "writable": true
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "rewardMany",
      "discriminator": [
        219,
        95,
        70,
        252,
        169,
        133,
        22,
        32
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "signer": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": [
        {
          "name": "amounts",
          "type": {
            "vec": "u64"
          }
        }
      ]
    },
    {
      "name": "setRecovery",
      "discriminator": [
        70,
        35,
        195,
        148,
        6,
        140,
        128,
        124
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "signer": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": [
        {
          "name": "newRecovery",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "settleDeath",
      "discriminator": [
        39,
        218,
        224,
        229,
        174,
        174,
        34,
        74
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "writable": true,
          "signer": true,
          "relations": [
            "world"
          ]
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "asset",
          "docs": [
            "own unfrozen asset natively, and Core leaves a one-byte stub; the death",
            "is settled all the same, so the stub is read by hand (`settled_owner`)",
            "rather than refused at load."
          ],
          "writable": true
        },
        {
          "name": "collection",
          "writable": true
        },
        {
          "name": "keeperCredit",
          "docs": [
            "The credit of whoever owns the asset at settlement. Present whenever",
            "the fly has a keeper; a WILD or OFFERED fly is the World PDA's own",
            "and passes none, as does a fly whose keeper burned the asset. The",
            "seed is spelled as an indexed byte array so the IDL builder, which can",
            "only describe constants, arguments and account fields, leaves the PDA",
            "undescribed instead of emitting the expression into the IDL."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "cause",
          "type": "u8"
        },
        {
          "name": "deathTick",
          "type": "u64"
        },
        {
          "name": "heirCount",
          "type": "u8"
        }
      ]
    },
    {
      "name": "sweepToRecovery",
      "discriminator": [
        181,
        204,
        31,
        18,
        176,
        159,
        213,
        187
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "recovery",
          "writable": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "transferOperator",
      "discriminator": [
        90,
        96,
        24,
        156,
        196,
        80,
        166,
        121
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "signer": true,
          "relations": [
            "world"
          ]
        }
      ],
      "args": [
        {
          "name": "newOperator",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "unlist",
      "discriminator": [
        185,
        125,
        20,
        193,
        209,
        44,
        13,
        224
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "creature",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "asset"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdraw",
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "credit"
          ]
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "withdrawTreasury",
      "discriminator": [
        40,
        63,
        122,
        158,
        144,
        216,
        83,
        96
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "operator",
          "signer": true,
          "relations": [
            "world"
          ]
        },
        {
          "name": "to",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "metabolismAmount",
          "type": "u64"
        },
        {
          "name": "poolAmount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "baseCollectionV1",
      "discriminator": [
        5
      ]
    },
    {
      "name": "creature",
      "discriminator": [
        190,
        165,
        70,
        89,
        66,
        46,
        136,
        221
      ]
    },
    {
      "name": "credit",
      "discriminator": [
        6,
        79,
        161,
        136,
        156,
        172,
        190,
        149
      ]
    },
    {
      "name": "world",
      "discriminator": [
        145,
        45,
        170,
        174,
        122,
        32,
        155,
        124
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notOperator",
      "msg": "signer is not the world operator"
    },
    {
      "code": 6001,
      "name": "notOwner",
      "msg": "signer is not the owner of the fly's asset"
    },
    {
      "code": 6002,
      "name": "wrongStatus",
      "msg": "the fly or the world is not in the status this action needs"
    },
    {
      "code": 6003,
      "name": "wrongId",
      "msg": "id is not the next in sequence, or the account passed is not the record it claims to be"
    },
    {
      "code": 6004,
      "name": "notForSale",
      "msg": "the fly is not for sale"
    },
    {
      "code": 6005,
      "name": "wrongPrice",
      "msg": "price does not match the sale price on record"
    },
    {
      "code": 6006,
      "name": "insolvent",
      "msg": "the world does not hold the lamports to back this ledger"
    },
    {
      "code": 6007,
      "name": "notWindingDown",
      "msg": "the world is not winding down"
    },
    {
      "code": 6008,
      "name": "notAbandoned",
      "msg": "the operator is still active; the world is not abandoned"
    },
    {
      "code": 6009,
      "name": "tooEarly",
      "msg": "the timer for this action has not elapsed"
    },
    {
      "code": 6010,
      "name": "epochNotMonotonic",
      "msg": "epoch or tick is not the next in sequence"
    },
    {
      "code": 6011,
      "name": "nothingToWithdraw",
      "msg": "nothing to withdraw"
    },
    {
      "code": 6012,
      "name": "windingDown",
      "msg": "the world is winding down; no new money may enter it"
    },
    {
      "code": 6013,
      "name": "recoveryIsOperator",
      "msg": "recovery must be an address other than the operator"
    },
    {
      "code": 6014,
      "name": "assetMismatch",
      "msg": "the asset account is not the fly's asset"
    },
    {
      "code": 6015,
      "name": "wrongCollection",
      "msg": "the collection account is not the world's collection"
    },
    {
      "code": 6016,
      "name": "notEscheated",
      "msg": "the world has not escheated; records and credits are still live"
    },
    {
      "code": 6017,
      "name": "recordsStillOpen",
      "msg": "creature records or credits are still open; close them first"
    }
  ],
  "types": [
    {
      "name": "baseCollectionV1",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "key",
            "type": {
              "defined": {
                "name": "key"
              }
            }
          },
          {
            "name": "updateAuthority",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "uri",
            "type": "string"
          },
          {
            "name": "numMinted",
            "type": "u32"
          },
          {
            "name": "currentSize",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "creature",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "parentId",
            "docs": [
              "`NO_PARENT` for a founder."
            ],
            "type": "u64"
          },
          {
            "name": "generation",
            "type": "u32"
          },
          {
            "name": "birthTick",
            "type": "u64"
          },
          {
            "name": "deathTick",
            "type": "u64"
          },
          {
            "name": "genomeHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "asset",
            "docs": [
              "The Metaplex Core asset that is this fly. Its `owner` is the keeper;",
              "the World PDA holds it while WILD or OFFERED. Kept after the burn as the",
              "record of which asset the fly was."
            ],
            "type": "pubkey"
          },
          {
            "name": "listedBy",
            "docs": [
              "Who listed the fly for resale; default when it is not listed. A",
              "listing is void once the asset has left that keeper's hands, and",
              "expires LISTING_MAX_AGE after `listed_at`."
            ],
            "type": "pubkey"
          },
          {
            "name": "listedAt",
            "type": "i64"
          },
          {
            "name": "vault",
            "docs": [
              "Lamports the fly has earned and holds, backed by the World account."
            ],
            "type": "u64"
          },
          {
            "name": "salePrice",
            "docs": [
              "OFFERED: the primary price. OWNED: the resale price, 0 = not listed."
            ],
            "type": "u64"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "pendingCull",
            "type": "bool"
          },
          {
            "name": "cullRequestedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "credit",
      "docs": [
        "Pull-payment balance. Anything owed to a human waits here until they take",
        "it, so a payout can never fail and strand the funds inside a settlement."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "key",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "uninitialized"
          },
          {
            "name": "assetV1"
          },
          {
            "name": "hashedAssetV1"
          },
          {
            "name": "pluginHeaderV1"
          },
          {
            "name": "pluginRegistryV1"
          },
          {
            "name": "collectionV1"
          }
        ]
      }
    },
    {
      "name": "world",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "operator",
            "type": "pubkey"
          },
          {
            "name": "pendingOperator",
            "type": "pubkey"
          },
          {
            "name": "recovery",
            "docs": [
              "Where an abandoned world's money goes. Fixed before the first lamport",
              "arrives; only a live operator may move it, never anyone in wind-down."
            ],
            "type": "pubkey"
          },
          {
            "name": "collection",
            "docs": [
              "The Metaplex Core collection every fly's asset belongs to. The World",
              "PDA is its update authority."
            ],
            "type": "pubkey"
          },
          {
            "name": "nextId",
            "type": "u64"
          },
          {
            "name": "totalAlive",
            "type": "u64"
          },
          {
            "name": "lastEpoch",
            "type": "u64"
          },
          {
            "name": "lastEpochTick",
            "type": "u64"
          },
          {
            "name": "lastStateHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "metabolism",
            "docs": [
              "Treasury that sets carrying capacity."
            ],
            "type": "u64"
          },
          {
            "name": "pool",
            "docs": [
              "Treasury that pays living flies every epoch."
            ],
            "type": "u64"
          },
          {
            "name": "totalVaults",
            "docs": [
              "Sum of every creature's vault. The world cannot read every creature in",
              "one transaction, so the total is carried here and moved with each vault."
            ],
            "type": "u64"
          },
          {
            "name": "totalCredit",
            "docs": [
              "Sum of every Credit account's amount, carried the same way."
            ],
            "type": "u64"
          },
          {
            "name": "lastOperatorAction",
            "docs": [
              "Refreshed by every operator action; silence past ABANDONED_AFTER opens",
              "the recovery paths to everyone."
            ],
            "type": "i64"
          },
          {
            "name": "windDown",
            "type": "bool"
          },
          {
            "name": "windDownAt",
            "type": "i64"
          },
          {
            "name": "escheated",
            "docs": [
              "Set by `escheat`: the ledger is zero and nothing is owed to anybody.",
              "Only then may the records themselves be closed for their rent."
            ],
            "type": "bool"
          },
          {
            "name": "closedRecords",
            "docs": [
              "Creature PDAs closed by `close_record`; the World may close once this",
              "reaches `next_id`."
            ],
            "type": "u64"
          },
          {
            "name": "creditsOpen",
            "docs": [
              "Credit PDAs that exist: counted on first initialisation, uncounted by",
              "`close_credit`. The World may close once this is zero."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
