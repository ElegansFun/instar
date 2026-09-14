use anchor_lang::prelude::*;

use crate::errors::InstarError;

pub const WORLD_SEED: &[u8] = b"world";
pub const CREATURE_SEED: &[u8] = b"creature";
pub const CREDIT_SEED: &[u8] = b"credit";

pub const BPS: u64 = 10_000;

/// Primary sale: most of the price is seeded into the fly itself.
pub const BUY_TO_VAULT_BPS: u64 = 6000;
pub const BUY_TO_METABOLISM_BPS: u64 = 1500;
pub const BUY_TO_POOL_BPS: u64 = 1500;
/// Ancestry royalty; only a parent that is still OWNED receives it.
pub const BUY_TO_PARENT_BPS: u64 = 1000;

/// Resale: the vault travels with the fly, so the price is only the premium.
pub const RESALE_TO_SELLER_BPS: u64 = 9000;
pub const RESALE_TO_METABOLISM_BPS: u64 = 500;
pub const RESALE_TO_POOL_BPS: u64 = 500;

/// Natural death: the estate.
pub const DEATH_TO_HEIRS_BPS: u64 = 4000;
pub const DEATH_TO_METABOLISM_BPS: u64 = 3500;
pub const DEATH_TO_POOL_BPS: u64 = 1500;
pub const DEATH_TO_KEEPER_BPS: u64 = 1000;

/// A cull the keeper asked for: the keeper takes most of the vault.
pub const CULL_TO_KEEPER_BPS: u64 = 8500;
pub const CULL_TO_METABOLISM_BPS: u64 = 1500;

/// Engine death cause for a cull (event kind 2, b = 6).
pub const CAUSE_CULLED: u8 = 6;

pub const NO_PARENT: u64 = u64::MAX;

pub const STATUS_OFFERED: u8 = 1;
pub const STATUS_OWNED: u8 = 2;
pub const STATUS_WILD: u8 = 3;
pub const STATUS_DEAD: u8 = 4;

/// Timers, in seconds of `Clock::unix_timestamp`. The short-timers feature is
/// for test builds only: a local validator cannot warp its clock, so the
/// recovery drills wait these out in real time.
#[cfg(not(feature = "short-timers"))]
pub const ABANDONED_AFTER: i64 = 90 * 86_400;
#[cfg(not(feature = "short-timers"))]
pub const ESCHEAT_AFTER: i64 = 180 * 86_400;
#[cfg(not(feature = "short-timers"))]
pub const CULL_TIMEOUT: i64 = 7 * 86_400;
/// A listing expires: the program cannot see a plain Core transfer, so a
/// listing made by A, voided by the asset leaving A's hands, would come back
/// to life the moment the asset returned to A, at a price A consented to for
/// a fly that has since kept earning. After this long it has to be made again.
#[cfg(not(feature = "short-timers"))]
pub const LISTING_MAX_AGE: i64 = 30 * 86_400;

#[cfg(feature = "short-timers")]
pub const ABANDONED_AFTER: i64 = 4;
#[cfg(feature = "short-timers")]
pub const ESCHEAT_AFTER: i64 = 4;
#[cfg(feature = "short-timers")]
pub const CULL_TIMEOUT: i64 = 3;
#[cfg(feature = "short-timers")]
pub const LISTING_MAX_AGE: i64 = 6;

#[account]
#[derive(InitSpace)]
pub struct World {
    pub operator: Pubkey,
    pub pending_operator: Pubkey,
    /// Where an abandoned world's money goes. Fixed before the first lamport
    /// arrives; only a live operator may move it, never anyone in wind-down.
    pub recovery: Pubkey,
    /// The Metaplex Core collection every fly's asset belongs to. The World
    /// PDA is its update authority.
    pub collection: Pubkey,
    pub next_id: u64,
    pub total_alive: u64,
    pub last_epoch: u64,
    pub last_epoch_tick: u64,
    pub last_state_hash: [u8; 32],
    /// Treasury that sets carrying capacity.
    pub metabolism: u64,
    /// Treasury that pays living flies every epoch.
    pub pool: u64,
    /// Sum of every creature's vault. The world cannot read every creature in
    /// one transaction, so the total is carried here and moved with each vault.
    pub total_vaults: u64,
    /// Sum of every Credit account's amount, carried the same way.
    pub total_credit: u64,
    /// Refreshed by every operator action; silence past ABANDONED_AFTER opens
    /// the recovery paths to everyone.
    pub last_operator_action: i64,
    pub wind_down: bool,
    pub wind_down_at: i64,
    /// Set by `escheat`: the ledger is zero and nothing is owed to anybody.
    /// Only then may the records themselves be closed for their rent.
    pub escheated: bool,
    /// Creature PDAs closed by `close_record`; the World may close once this
    /// reaches `next_id`.
    pub closed_records: u64,
    /// Credit PDAs that exist: counted on first initialisation, uncounted by
    /// `close_credit`. The World may close once this is zero.
    pub credits_open: u64,
    pub bump: u8,
}

impl World {
    pub const SIZE: usize = 8 + World::INIT_SPACE;

    /// Lamports the world owes: everything on the ledger that somebody can claim.
    pub fn accounted(&self) -> Result<u64> {
        self.metabolism
            .checked_add(self.pool)
            .and_then(|s| s.checked_add(self.total_vaults))
            .and_then(|s| s.checked_add(self.total_credit))
            .ok_or_else(|| error!(InstarError::Insolvent))
    }

    pub fn abandoned(&self, now: i64) -> bool {
        now > self.last_operator_action.saturating_add(ABANDONED_AFTER)
    }

    pub fn touch(&mut self) -> Result<()> {
        self.last_operator_action = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Creature {
    pub id: u64,
    /// `NO_PARENT` for a founder.
    pub parent_id: u64,
    pub generation: u32,
    pub birth_tick: u64,
    pub death_tick: u64,
    pub genome_hash: [u8; 32],
    /// The Metaplex Core asset that is this fly. Its `owner` is the keeper;
    /// the World PDA holds it while WILD or OFFERED. Kept after the burn as the
    /// record of which asset the fly was.
    pub asset: Pubkey,
    /// Who listed the fly for resale; default when it is not listed. A
    /// listing is void once the asset has left that keeper's hands, and
    /// expires LISTING_MAX_AGE after `listed_at`.
    pub listed_by: Pubkey,
    pub listed_at: i64,
    /// Lamports the fly has earned and holds, backed by the World account.
    pub vault: u64,
    /// OFFERED: the primary price. OWNED: the resale price, 0 = not listed.
    pub sale_price: u64,
    pub status: u8,
    pub pending_cull: bool,
    pub cull_requested_at: i64,
    pub bump: u8,
}

impl Creature {
    pub const SIZE: usize = 8 + Creature::INIT_SPACE;

    pub fn alive(&self) -> bool {
        matches!(self.status, STATUS_OFFERED | STATUS_OWNED | STATUS_WILD)
    }

    pub fn clear_listing(&mut self) {
        self.sale_price = 0;
        self.listed_by = Pubkey::default();
        self.listed_at = 0;
    }
}

/// Pull-payment balance. Anything owed to a human waits here until they take
/// it, so a payout can never fail and strand the funds inside a settlement.
#[account]
#[derive(InitSpace)]
pub struct Credit {
    pub owner: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

impl Credit {
    pub const SIZE: usize = 8 + Credit::INIT_SPACE;
}
