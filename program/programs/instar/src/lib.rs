//! Instar: the permanent record of a world of larvae whose brains are the
//! Winding et al. 2023 larval connectome.
//!
//! The simulation runs off-chain in a deterministic engine; nothing could run
//! it here. What lives on chain is everything that has to be permanent and
//! checkable: each larva's identity and ancestry as a Metaplex Core asset in
//! the world's collection, the lamports it earns, the market it trades in,
//! and a state hash committed every epoch so anyone replaying the engine can
//! verify the operator is not lying.
//!
//! Design rule: every balance this program holds has a withdrawal path that
//! exists from deployment and does not depend on any off-chain process being
//! alive. Keepers pull their own funds, the operator recovers the treasuries,
//! and an abandoned world opens every exit to everybody.

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod money;
pub mod nft;
pub mod state;

use instructions::*;

declare_id!("75rMBkZtwuc3BHrtD2F3Sd7fMgirF2mzA4yfMQW4NLcM");

#[program]
pub mod instar {
    use super::*;

    pub fn init_world(ctx: Context<InitWorld>, recovery: Pubkey, collection_uri: String) -> Result<()> {
        instructions::init_world(ctx, recovery, collection_uri)
    }

    pub fn set_recovery(ctx: Context<OperatorOnly>, new_recovery: Pubkey) -> Result<()> {
        instructions::set_recovery(ctx, new_recovery)
    }

    pub fn transfer_operator(ctx: Context<OperatorOnly>, new_operator: Pubkey) -> Result<()> {
        instructions::transfer_operator(ctx, new_operator)
    }

    pub fn accept_operator(ctx: Context<AcceptOperator>) -> Result<()> {
        instructions::accept_operator(ctx)
    }

    pub fn heartbeat(ctx: Context<OperatorOnly>) -> Result<()> {
        instructions::heartbeat(ctx)
    }

    pub fn post_epoch(ctx: Context<OperatorOnly>, epoch: u64, tick: u64, state_hash: [u8; 32]) -> Result<()> {
        instructions::post_epoch(ctx, epoch, tick, state_hash)
    }

    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, metabolism_amount: u64, pool_amount: u64) -> Result<()> {
        instructions::withdraw_treasury(ctx, metabolism_amount, pool_amount)
    }

    pub fn fund(ctx: Context<Fund>, amount: u64, pool_bps: u16) -> Result<()> {
        instructions::fund(ctx, amount, pool_bps)
    }

    pub fn register_birth(
        ctx: Context<RegisterBirth>,
        id: u64,
        parent_id: u64,
        generation: u32,
        birth_tick: u64,
        genome_hash: [u8; 32],
        uri: String,
    ) -> Result<()> {
        instructions::register_birth(ctx, id, parent_id, generation, birth_tick, genome_hash, uri)
    }

    pub fn open_offer(ctx: Context<OperatorOnCreature>, id: u64, price: u64) -> Result<()> {
        instructions::open_offer(ctx, id, price)
    }

    pub fn reward_many<'info>(ctx: Context<'_, '_, 'info, 'info, RewardMany<'info>>, amounts: Vec<u64>) -> Result<()> {
        instructions::reward_many(ctx, amounts)
    }

    pub fn settle_death<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleDeath<'info>>,
        id: u64,
        cause: u8,
        death_tick: u64,
        heir_count: u8,
    ) -> Result<()> {
        instructions::settle_death(ctx, id, cause, death_tick, heir_count)
    }

    pub fn request_cull(ctx: Context<OwnerOnCreature>, id: u64) -> Result<()> {
        instructions::request_cull(ctx, id)
    }

    pub fn force_settle_cull(ctx: Context<ForceSettleCull>, id: u64) -> Result<()> {
        instructions::force_settle_cull(ctx, id)
    }

    pub fn buy(ctx: Context<Buy>, id: u64, price: u64) -> Result<()> {
        instructions::buy(ctx, id, price)
    }

    pub fn list(ctx: Context<Listing>, id: u64, price: u64) -> Result<()> {
        instructions::list(ctx, id, price)
    }

    pub fn unlist(ctx: Context<Listing>, id: u64) -> Result<()> {
        instructions::unlist(ctx, id)
    }

    pub fn buy_listed(ctx: Context<BuyListed>, id: u64, price: u64) -> Result<()> {
        instructions::buy_listed(ctx, id, price)
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::withdraw(ctx)
    }

    pub fn begin_wind_down(ctx: Context<BeginWindDown>) -> Result<()> {
        instructions::begin_wind_down(ctx)
    }

    pub fn reclaim_vault(ctx: Context<ReclaimVault>, id: u64) -> Result<()> {
        instructions::reclaim_vault(ctx, id)
    }

    pub fn sweep_to_recovery(ctx: Context<ToRecovery>) -> Result<()> {
        instructions::sweep_to_recovery(ctx)
    }

    pub fn escheat(ctx: Context<ToRecovery>) -> Result<()> {
        instructions::escheat(ctx)
    }

    pub fn close_record(ctx: Context<CloseRecord>, id: u64) -> Result<()> {
        instructions::close_record(ctx, id)
    }

    pub fn close_credit(ctx: Context<CloseCredit>) -> Result<()> {
        instructions::close_credit(ctx)
    }

    pub fn close_world(ctx: Context<CloseWorld>) -> Result<()> {
        instructions::close_world(ctx)
    }
}
