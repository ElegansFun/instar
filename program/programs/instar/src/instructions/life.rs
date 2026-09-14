//! Birth, epoch rewards, death and cull settlement: the operator's crank.

use anchor_lang::prelude::*;
use mpl_core::accounts::BaseCollectionV1;

use crate::errors::InstarError;
use crate::money::{add, assert_solvent, bps, sub};
use crate::nft::{live_owner, settled_owner, Core, LarvaAsset, MplCore};
use crate::state::*;

/// A creature passed through `remaining_accounts`: owner and discriminator are
/// checked by Anchor, the PDA address is checked here so a caller cannot hand
/// in a real record under a different id.
pub fn load_creature<'info>(info: &'info AccountInfo<'info>) -> Result<Account<'info, Creature>> {
    let creature = Account::<Creature>::try_from(info)?;
    let expected = Pubkey::create_program_address(
        &[CREATURE_SEED, &creature.id.to_le_bytes(), &[creature.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(InstarError::WrongId))?;
    require_keys_eq!(expected, *info.key, InstarError::WrongId);
    Ok(creature)
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct RegisterBirth<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = operator @ InstarError::NotOperator)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(init, payer = operator, space = Creature::SIZE, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump)]
    pub creature: Account<'info, Creature>,
    /// The fly's Core asset: a fresh keypair the client signs for.
    #[account(mut)]
    pub asset: Signer<'info>,
    #[account(mut, address = world.collection @ InstarError::WrongCollection)]
    pub collection: Account<'info, BaseCollectionV1>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

/// A birth in the engine becomes a permanent identity here. The engine names
/// its flies, not the program: the id is passed in and must be the next one,
/// so the journal and the chain can never disagree about who #7 is. The
/// asset is minted to the World PDA: the dish holds flies nobody has bought.
#[allow(clippy::too_many_arguments)]
pub fn register_birth(
    ctx: Context<RegisterBirth>,
    id: u64,
    parent_id: u64,
    generation: u32,
    birth_tick: u64,
    genome_hash: [u8; 32],
    uri: String,
) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require!(!world.wind_down, InstarError::WindingDown);
    require!(id == world.next_id, InstarError::WrongId);
    world.next_id = add(world.next_id, 1)?;
    world.total_alive = add(world.total_alive, 1)?;
    world.touch()?;

    let c = &mut ctx.accounts.creature;
    c.id = id;
    c.parent_id = parent_id;
    c.generation = generation;
    c.birth_tick = birth_tick;
    c.genome_hash = genome_hash;
    c.asset = ctx.accounts.asset.key();
    c.status = STATUS_WILD;
    c.bump = ctx.bumps.creature;

    Core {
        program: &ctx.accounts.mpl_core_program,
        world: &ctx.accounts.world,
        collection: ctx.accounts.collection.as_ref(),
        payer: &ctx.accounts.operator,
        system_program: &ctx.accounts.system_program,
    }
    .create_asset(&ctx.accounts.asset, id, parent_id, generation, birth_tick, &genome_hash, uri)
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct OperatorOnCreature<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = operator @ InstarError::NotOperator)]
    pub world: Account<'info, World>,
    pub operator: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump)]
    pub creature: Account<'info, Creature>,
    #[account(address = creature.asset @ InstarError::AssetMismatch)]
    pub asset: Account<'info, LarvaAsset>,
}

/// Put a fly the dish holds up for sale at a fixed price: a newborn, or a
/// kept fly whose keeper sent the asset back to the World PDA with a plain
/// Core transfer. Either way the asset must be the World PDA's; a fly in a
/// keeper's hands is sold by `list`, never by the operator.
pub fn open_offer(ctx: Context<OperatorOnCreature>, _id: u64, price: u64) -> Result<()> {
    require!(!ctx.accounts.world.wind_down, InstarError::WindingDown);
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_WILD || c.status == STATUS_OWNED, InstarError::WrongStatus);
    require_keys_eq!(ctx.accounts.asset.owner, ctx.accounts.world.key(), InstarError::WrongStatus);
    c.status = STATUS_OFFERED;
    c.clear_listing();
    c.sale_price = price;
    ctx.accounts.world.touch()
}

#[derive(Accounts)]
pub struct RewardMany<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = operator @ InstarError::NotOperator)]
    pub world: Account<'info, World>,
    pub operator: Signer<'info>,
}

/// Pay a whole epoch's life rewards in one transaction, pool to vaults.
/// A DEAD fly is skipped rather than failing the batch: deaths are settled
/// on the same queue, so a fly dying between scoring and landing is ordinary
/// and must not cost everyone else their epoch.
pub fn reward_many<'info>(ctx: Context<'_, '_, 'info, 'info, RewardMany<'info>>, amounts: Vec<u64>) -> Result<()> {
    // In wind-down the pool is being swept to recovery; moving it into vaults
    // would only create claims that escheat later empties from under keepers.
    require!(!ctx.accounts.world.wind_down, InstarError::WindingDown);
    require!(ctx.remaining_accounts.len() == amounts.len(), InstarError::WrongId);
    let mut spent: u64 = 0;
    for (info, amount) in ctx.remaining_accounts.iter().zip(amounts) {
        let mut c = load_creature(info)?;
        if c.status == STATUS_DEAD || amount == 0 {
            continue;
        }
        c.vault = add(c.vault, amount)?;
        spent = add(spent, amount)?;
        c.exit(&crate::ID)?;
    }
    let world = &mut ctx.accounts.world;
    require!(spent <= world.pool, InstarError::Insolvent);
    world.pool = sub(world.pool, spent)?;
    world.total_vaults = add(world.total_vaults, spent)?;
    world.touch()?;
    assert_solvent(world)
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct SettleDeath<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = operator @ InstarError::NotOperator)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump)]
    pub creature: Account<'info, Creature>,
    /// CHECK: `creature.asset`, still owned by Core. A keeper can burn their
    /// own unfrozen asset natively, and Core leaves a one-byte stub; the death
    /// is settled all the same, so the stub is read by hand (`settled_owner`)
    /// rather than refused at load.
    #[account(mut, address = creature.asset @ InstarError::AssetMismatch, owner = mpl_core::ID @ InstarError::AssetMismatch)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, address = world.collection @ InstarError::WrongCollection)]
    pub collection: Account<'info, BaseCollectionV1>,
    /// The credit of whoever owns the asset at settlement. Present whenever
    /// the fly has a keeper; a WILD or OFFERED fly is the World PDA's own
    /// and passes none, as does a fly whose keeper burned the asset. The
    /// seed is spelled as an indexed byte array so the IDL builder, which can
    /// only describe constants, arguments and account fields, leaves the PDA
    /// undescribed instead of emitting the expression into the IDL.
    #[account(
        init_if_needed,
        payer = operator,
        space = Credit::SIZE,
        seeds = [CREDIT_SEED, &live_owner(&asset)?.to_bytes()[..]],
        bump,
    )]
    pub keeper_credit: Option<Account<'info, Credit>>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

/// Settle a death. A pending cull is the keeper's own request, whatever cause
/// the engine records, and pays them most of the vault; anything else is the
/// world taking its course and the estate is split between heirs, treasuries
/// and keeper. In wind-down the whole vault is the keeper's, as it would be
/// through `reclaim_vault`. The keeper is whoever owns the asset now; the
/// asset is burned at the end. A keeper who already burned it natively
/// forfeited the keeper share, which goes to metabolism as for a fly nobody
/// kept.
pub fn settle_death<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleDeath<'info>>,
    id: u64,
    cause: u8,
    death_tick: u64,
    heir_count: u8,
) -> Result<()> {
    let heir_count = usize::from(heir_count);
    require!(ctx.remaining_accounts.len() >= heir_count, InstarError::WrongId);
    let c = &mut ctx.accounts.creature;
    require!(c.status != STATUS_DEAD, InstarError::WrongStatus);
    let owner = settled_owner(&ctx.accounts.asset)?;
    let keeper = owner.filter(|owner| *owner != ctx.accounts.world.key());
    // a credit for the World PDA could never be closed
    require!(keeper.is_some() || ctx.accounts.keeper_credit.is_none(), InstarError::WrongId);
    let estate = c.vault;
    c.vault = 0;
    c.clear_listing();
    c.status = STATUS_DEAD;
    c.death_tick = death_tick;

    let world = &mut ctx.accounts.world;
    world.total_alive = sub(world.total_alive, 1)?;
    world.total_vaults = sub(world.total_vaults, estate)?;

    let mut to_keeper: u64 = 0;
    if estate > 0 {
        if world.wind_down {
            to_keeper = estate;
        } else if c.pending_cull {
            to_keeper = bps(estate, CULL_TO_KEEPER_BPS)?;
            world.metabolism = add(world.metabolism, sub(estate, to_keeper)?)?;
        } else {
            let to_heirs = bps(estate, DEATH_TO_HEIRS_BPS)?;
            let mut to_metab = bps(estate, DEATH_TO_METABOLISM_BPS)?;
            let mut to_pool = bps(estate, DEATH_TO_POOL_BPS)?;
            to_keeper = sub(sub(sub(estate, to_heirs)?, to_metab)?, to_pool)?;

            if heir_count > 0 {
                let each = to_heirs / heir_count as u64;
                // offspring are born after their parent, so ids only climb from here;
                // strict order also rules out the same heir account twice
                let mut last_id = id;
                for info in &ctx.remaining_accounts[..heir_count] {
                    let mut heir = load_creature(info)?;
                    require!(heir.alive(), InstarError::WrongStatus);
                    require!(heir.parent_id == id && heir.id > last_id, InstarError::WrongId);
                    last_id = heir.id;
                    heir.vault = add(heir.vault, each)?;
                    heir.exit(&crate::ID)?;
                }
                let paid = each * heir_count as u64;
                world.total_vaults = add(world.total_vaults, paid)?;
                // dust from the division stays in the pool, never stranded
                to_pool = add(to_pool, sub(to_heirs, paid)?)?;
            } else {
                to_metab = add(to_metab, to_heirs)?;
            }
            world.metabolism = add(world.metabolism, to_metab)?;
            world.pool = add(world.pool, to_pool)?;
        }
    }

    if to_keeper > 0 {
        if let Some(keeper) = keeper {
            let credit = ctx.accounts.keeper_credit.as_mut().ok_or_else(|| error!(InstarError::WrongId))?;
            if credit.owner == Pubkey::default() {
                world.credits_open = add(world.credits_open, 1)?;
            }
            credit.owner = keeper;
            credit.bump = ctx.bumps.keeper_credit.unwrap_or(credit.bump);
            credit.amount = add(credit.amount, to_keeper)?;
            world.total_credit = add(world.total_credit, to_keeper)?;
        } else {
            world.metabolism = add(world.metabolism, to_keeper)?;
        }
    }
    world.touch()?;
    assert_solvent(world)?;
    if owner.is_none() {
        return Ok(());
    }
    Core {
        program: &ctx.accounts.mpl_core_program,
        world: &ctx.accounts.world,
        collection: ctx.accounts.collection.as_ref(),
        payer: &ctx.accounts.operator,
        system_program: &ctx.accounts.system_program,
    }
    .burn(&ctx.accounts.asset)
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct OwnerOnCreature<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump)]
    pub creature: Account<'info, Creature>,
    #[account(mut, address = creature.asset @ InstarError::AssetMismatch, constraint = asset.owner == owner.key() @ InstarError::NotOwner)]
    pub asset: Account<'info, LarvaAsset>,
    #[account(mut, address = world.collection @ InstarError::WrongCollection)]
    pub collection: Account<'info, BaseCollectionV1>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

/// The keeper asks for the fly to be culled. The engine kills it at a
/// deterministic tick and the operator settles it; if the operator never
/// comes, `force_settle_cull` after CULL_TIMEOUT. The asset is frozen so it
/// cannot leave the dish in the meantime; the settlement burns it.
pub fn request_cull(ctx: Context<OwnerOnCreature>, _id: u64) -> Result<()> {
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_OWNED, InstarError::WrongStatus);
    require!(!c.pending_cull, InstarError::WrongStatus);
    c.pending_cull = true;
    c.cull_requested_at = Clock::get()?.unix_timestamp;
    c.clear_listing();
    Core {
        program: &ctx.accounts.mpl_core_program,
        world: &ctx.accounts.world,
        collection: ctx.accounts.collection.as_ref(),
        payer: &ctx.accounts.owner,
        system_program: &ctx.accounts.system_program,
    }
    .freeze(ctx.accounts.asset.as_ref())
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct ForceSettleCull<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump)]
    pub world: Account<'info, World>,
    /// Anyone; only the keeper is paid, so a stranger pressing it just helps.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump)]
    pub creature: Account<'info, Creature>,
    #[account(mut, address = creature.asset @ InstarError::AssetMismatch)]
    pub asset: Account<'info, LarvaAsset>,
    #[account(mut, address = world.collection @ InstarError::WrongCollection)]
    pub collection: Account<'info, BaseCollectionV1>,
    #[account(
        init_if_needed,
        payer = payer,
        space = Credit::SIZE,
        seeds = [CREDIT_SEED, asset.owner.as_ref()],
        bump,
    )]
    pub keeper_credit: Account<'info, Credit>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

/// A cull the operator never answered, settled by anyone after the timeout
/// with the same 85/15 split the operator would have applied, paid to whoever
/// owns the asset now. The asset is burned as in any settlement.
pub fn force_settle_cull(ctx: Context<ForceSettleCull>, _id: u64) -> Result<()> {
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_OWNED, InstarError::WrongStatus);
    require!(c.pending_cull, InstarError::WrongStatus);
    let now = Clock::get()?.unix_timestamp;
    require!(now > c.cull_requested_at.saturating_add(CULL_TIMEOUT), InstarError::TooEarly);

    let estate = c.vault;
    c.vault = 0;
    c.clear_listing();
    c.status = STATUS_DEAD;

    let world = &mut ctx.accounts.world;
    world.total_alive = sub(world.total_alive, 1)?;
    world.total_vaults = sub(world.total_vaults, estate)?;
    let to_keeper = bps(estate, CULL_TO_KEEPER_BPS)?;
    world.metabolism = add(world.metabolism, sub(estate, to_keeper)?)?;
    world.total_credit = add(world.total_credit, to_keeper)?;

    let credit = &mut ctx.accounts.keeper_credit;
    if credit.owner == Pubkey::default() {
        world.credits_open = add(world.credits_open, 1)?;
    }
    credit.owner = ctx.accounts.asset.owner;
    credit.bump = ctx.bumps.keeper_credit;
    credit.amount = add(credit.amount, to_keeper)?;
    assert_solvent(world)?;
    Core {
        program: &ctx.accounts.mpl_core_program,
        world: &ctx.accounts.world,
        collection: ctx.accounts.collection.as_ref(),
        payer: &ctx.accounts.payer,
        system_program: &ctx.accounts.system_program,
    }
    .burn(ctx.accounts.asset.as_ref())
}
