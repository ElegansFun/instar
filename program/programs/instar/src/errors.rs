use anchor_lang::prelude::*;

#[error_code]
pub enum InstarError {
    #[msg("signer is not the world operator")]
    NotOperator,
    #[msg("signer is not the larva's keeper")]
    NotKeeper,
    #[msg("the larva or the world is not in the status this action needs")]
    WrongStatus,
    #[msg("id is not the next in sequence, or the account passed is not the record it claims to be")]
    WrongId,
    #[msg("the larva is not for sale")]
    NotForSale,
    #[msg("price does not match the sale price on record")]
    WrongPrice,
    #[msg("the world does not hold the lamports to back this ledger")]
    Insolvent,
    #[msg("the world is not winding down")]
    NotWindingDown,
    #[msg("the operator is still active; the world is not abandoned")]
    NotAbandoned,
    #[msg("the timer for this action has not elapsed")]
    TooEarly,
    #[msg("epoch or tick is not the next in sequence")]
    EpochNotMonotonic,
    #[msg("nothing to withdraw")]
    NothingToWithdraw,
    #[msg("the world is winding down; no new money may enter it")]
    WindingDown,
    #[msg("recovery must be an address other than the operator")]
    RecoveryIsOperator,
}
