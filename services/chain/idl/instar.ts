/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/instar.json`.
 */
export type Instar = {
  "address": "APHUkCBn8xAiZw4Yuzf4eZDiv2zfh26Zr5NupxT1J181",
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
          "name": "sellerCredit",
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
                "path": "creature.keeper",
                "account": "creature"
              }
            ]
          }
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
                "path": "creature.keeper",
                "account": "creature"
              }
            ]
          }
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
          "name": "program",
          "address": "APHUkCBn8xAiZw4Yuzf4eZDiv2zfh26Zr5NupxT1J181"
        },
        {
          "name": "programData"
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
          "name": "keeper",
          "signer": true,
          "relations": [
            "creature"
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
          "name": "keeper",
          "writable": true,
          "signer": true,
          "relations": [
            "creature"
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
                "path": "keeper"
              }
            ]
          }
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
          "name": "keeper",
          "signer": true,
          "relations": [
            "creature"
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
          "name": "keeperCredit",
          "docs": [
            "Present whenever the larva has a keeper; a WILD or OFFERED larva has",
            "nobody to pay and passes none."
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
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "creature.keeper",
                "account": "creature"
              }
            ]
          }
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
      "name": "transfer",
      "discriminator": [
        163,
        52,
        200,
        231,
        140,
        3,
        69,
        186
      ],
      "accounts": [
        {
          "name": "keeper",
          "signer": true,
          "relations": [
            "creature"
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
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "to",
          "type": "pubkey"
        }
      ]
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
          "name": "keeper",
          "signer": true,
          "relations": [
            "creature"
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
      "name": "notKeeper",
      "msg": "signer is not the larva's keeper"
    },
    {
      "code": 6002,
      "name": "wrongStatus",
      "msg": "the larva or the world is not in the status this action needs"
    },
    {
      "code": 6003,
      "name": "wrongId",
      "msg": "id is not the next in sequence, or the account passed is not the record it claims to be"
    },
    {
      "code": 6004,
      "name": "notForSale",
      "msg": "the larva is not for sale"
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
    }
  ],
  "types": [
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
            "name": "keeper",
            "docs": [
              "Default pubkey while WILD or OFFERED. Kept after death as the record of",
              "who held the larva last; a DEAD larva is not transferable in any case."
            ],
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "Lamports the larva has earned and holds, backed by the World account."
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
              "Treasury that pays living larvae every epoch."
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
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
