//! The World PDA holds every lamport the program is responsible for. These are
//! the only three ways lamports cross its boundary, so the solvency invariant
//! can be checked in one place.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::InstarError;
use crate::state::World;

/// Lamports in: a CPI transfer from a system-owned payer to the World account.
pub fn deposit<'info>(
    from: &Signer<'info>,
    world: &Account<'info, World>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(
            system_program.to_account_info(),
            system_program::Transfer {
                from: from.to_account_info(),
                to: world.to_account_info(),
            },
        ),
        amount,
    )
}

/// Lamports out: a direct debit of the program-owned World account and a
/// credit to any writable recipient. No CPI, so a recipient can never refuse.
pub fn pay_out<'info>(world: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let remaining = world
        .lamports()
        .checked_sub(amount)
        .ok_or_else(|| error!(InstarError::Insolvent))?;
    **world.try_borrow_mut_lamports()? = remaining;
    let received = to
        .lamports()
        .checked_add(amount)
        .ok_or_else(|| error!(InstarError::Insolvent))?;
    **to.try_borrow_mut_lamports()? = received;
    Ok(())
}

/// Lamports the world may spend: its balance above the rent-exempt minimum.
pub fn free_lamports(world: &Account<'_, World>) -> Result<u64> {
    let info = world.to_account_info();
    let rent = Rent::get()?.minimum_balance(info.data_len());
    info.lamports()
        .checked_sub(rent)
        .ok_or_else(|| error!(InstarError::Insolvent))
}

/// The invariant every money-moving instruction ends with: the balance above
/// rent covers everything the ledger says somebody can claim.
pub fn assert_solvent(world: &Account<'_, World>) -> Result<()> {
    require!(free_lamports(world)? >= world.accounted()?, InstarError::Insolvent);
    Ok(())
}

pub fn bps(amount: u64, share: u64) -> Result<u64> {
    amount
        .checked_mul(share)
        .map(|v| v / crate::state::BPS)
        .ok_or_else(|| error!(InstarError::Insolvent))
}

pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| error!(InstarError::Insolvent))
}

pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or_else(|| error!(InstarError::Insolvent))
}
