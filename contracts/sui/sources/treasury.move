/// TreasuryForge - Sui Treasury Module with DeepBook Integration
///
/// Manages bridged USDC on Sui, deploys liquidity into DeepBook pools
/// for yield optimization, and supports PTB-composable rebalancing.
///
/// Flow: Bridge USDC (via LI.FI) → Deposit to Treasury → Agent deploys
/// to DeepBook pools → Earn yield → Withdraw & payout
module treasury_forge::treasury {
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::event;
    use sui::clock::Clock;
    use deepbook::clob_v2 as deepbook;
    use deepbook::clob_v2::Pool;
    use deepbook::custodian_v2::AccountCap;

    // ============ Error Codes ============

    const E_NOT_AGENT: u64 = 0;
    const E_NOT_ADMIN: u64 = 1;
    const E_INSUFFICIENT_BALANCE: u64 = 2;
    const E_ZERO_AMOUNT: u64 = 3;

    // ============ DeepBook Order Restrictions ============

    const NO_RESTRICTION: u8 = 0;
    const POST_ONLY: u8 = 3;

    // ============ Objects ============

    /// Shared treasury that holds funds and owns a DeepBook custodian account.
    /// Parameterized by the quote asset type (e.g., USDC).
    public struct Treasury<phantom T> has key {
        id: UID,
        admin: address,
        agent: address,
        balance: Balance<T>,
        total_deposited: u64,
        total_in_pools: u64,
        account_cap: AccountCap,
    }

    /// Admin capability for privileged operations (withdraw, set agent).
    public struct AdminCap has key, store {
        id: UID,
    }

    // ============ Events ============

    public struct TreasuryCreated has copy, drop {
        treasury_id: address,
        admin: address,
    }

    public struct Deposited has copy, drop {
        depositor: address,
        amount: u64,
    }

    public struct Withdrawn has copy, drop {
        recipient: address,
        amount: u64,
    }

    public struct PoolAction has copy, drop {
        action: vector<u8>,
        amount: u64,
    }

    public struct OrderPlaced has copy, drop {
        client_order_id: u64,
        price: u64,
        quantity: u64,
        is_bid: bool,
    }

    public struct OrderCancelled has copy, drop {
        order_id: u64,
    }

    public struct AgentUpdated has copy, drop {
        new_agent: address,
    }

    // ========================================================================
    // Treasury Creation
    // ========================================================================

    /// Create a new Treasury. Caller becomes admin and default agent.
    /// Treasury is shared so agent + users can interact with it.
    /// AdminCap is transferred to the caller.
    public entry fun create_treasury<T>(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        let account_cap = deepbook::create_account(ctx);

        let treasury = Treasury<T> {
            id: object::new(ctx),
            admin: sender,
            agent: sender,
            balance: balance::zero<T>(),
            total_deposited: 0,
            total_in_pools: 0,
            account_cap,
        };

        let treasury_addr = object::uid_to_address(&treasury.id);
        transfer::share_object(treasury);
        transfer::transfer(AdminCap { id: object::new(ctx) }, sender);

        event::emit(TreasuryCreated { treasury_id: treasury_addr, admin: sender });
    }

    // ========================================================================
    // Deposit / Withdraw
    // ========================================================================

    /// Anyone can deposit coins into the treasury (e.g., bridged USDC from Arc).
    public entry fun deposit<T>(
        treasury: &mut Treasury<T>,
        coin: Coin<T>,
        ctx: &TxContext,
    ) {
        let amount = coin::value(&coin);
        assert!(amount > 0, E_ZERO_AMOUNT);

        balance::join(&mut treasury.balance, coin::into_balance(coin));
        treasury.total_deposited = treasury.total_deposited + amount;

        event::emit(Deposited { depositor: tx_context::sender(ctx), amount });
    }

    /// Admin withdraws coins from the treasury to a recipient (e.g., payout).
    public entry fun withdraw<T>(
        treasury: &mut Treasury<T>,
        _cap: &AdminCap,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(balance::value(&treasury.balance) >= amount, E_INSUFFICIENT_BALANCE);

        let coin = coin::from_balance(balance::split(&mut treasury.balance, amount), ctx);
        transfer::public_transfer(coin, recipient);

        event::emit(Withdrawn { recipient, amount });
    }

    // ========================================================================
    // DeepBook Pool Operations (Agent-Gated)
    // ========================================================================

    /// Agent deposits quote asset (USDC) from treasury into a DeepBook pool.
    /// This makes the funds available for limit order placement.
    public entry fun deposit_quote<BaseAsset, QuoteAsset>(
        treasury: &mut Treasury<QuoteAsset>,
        pool: &mut Pool<BaseAsset, QuoteAsset>,
        amount: u64,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == treasury.agent, E_NOT_AGENT);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(balance::value(&treasury.balance) >= amount, E_INSUFFICIENT_BALANCE);

        let coin = coin::from_balance(balance::split(&mut treasury.balance, amount), ctx);
        deepbook::deposit_quote(pool, coin, &treasury.account_cap);
        treasury.total_in_pools = treasury.total_in_pools + amount;

        event::emit(PoolAction { action: b"deposit_quote", amount });
    }

    /// Agent deposits base asset from treasury into a DeepBook pool.
    public entry fun deposit_base<BaseAsset, QuoteAsset>(
        treasury: &mut Treasury<BaseAsset>,
        pool: &mut Pool<BaseAsset, QuoteAsset>,
        amount: u64,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == treasury.agent, E_NOT_AGENT);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(balance::value(&treasury.balance) >= amount, E_INSUFFICIENT_BALANCE);

        let coin = coin::from_balance(balance::split(&mut treasury.balance, amount), ctx);
        deepbook::deposit_base(pool, coin, &treasury.account_cap);
        treasury.total_in_pools = treasury.total_in_pools + amount;

        event::emit(PoolAction { action: b"deposit_base", amount });
    }

    /// Agent withdraws quote asset from a DeepBook pool back to treasury.
    public entry fun withdraw_quote<BaseAsset, QuoteAsset>(
        treasury: &mut Treasury<QuoteAsset>,
        pool: &mut Pool<BaseAsset, QuoteAsset>,
        amount: u64,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == treasury.agent, E_NOT_AGENT);

        let coin = deepbook::withdraw_quote(pool, amount, &treasury.account_cap, ctx);
        let actual = coin::value(&coin);
        balance::join(&mut treasury.balance, coin::into_balance(coin));

        if (treasury.total_in_pools >= actual) {
            treasury.total_in_pools = treasury.total_in_pools - actual;
        } else {
            treasury.total_in_pools = 0;
        };

        event::emit(PoolAction { action: b"withdraw_quote", amount: actual });
    }

    /// Agent withdraws base asset from a DeepBook pool back to treasury.
    public entry fun withdraw_base<BaseAsset, QuoteAsset>(
        treasury: &mut Treasury<BaseAsset>,
        pool: &mut Pool<BaseAsset, QuoteAsset>,
        amount: u64,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == treasury.agent, E_NOT_AGENT);

        let coin = deepbook::withdraw_base(pool, amount, &treasury.account_cap, ctx);
        let actual = coin::value(&coin);
        balance::join(&mut treasury.balance, coin::into_balance(coin));

        if (treasury.total_in_pools >= actual) {
            treasury.total_in_pools = treasury.total_in_pools - actual;
        } else {
            treasury.total_in_pools = 0;
        };

        event::emit(PoolAction { action: b"withdraw_base", amount: actual });
    }

    // ========================================================================
    // DeepBook Order Management (Agent-Gated, PTB-Composable)
    // ========================================================================

    /// Agent places a limit order on a DeepBook pool.
    /// Returns (order_id, base_filled, is_placed, quote_filled) for PTB composition.
    ///
    /// Example PTB: deposit_quote → place_limit_order (atomic in one tx)
    public fun place_limit_order<BaseAsset, QuoteAsset>(
        treasury: &mut Treasury<QuoteAsset>,
        pool: &mut Pool<BaseAsset, QuoteAsset>,
        client_order_id: u64,
        price: u64,
        quantity: u64,
        self_matching_prevention: u8,
        is_bid: bool,
        expire_timestamp: u64,
        restriction: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ): (u64, u64, bool, u64) {
        assert!(tx_context::sender(ctx) == treasury.agent, E_NOT_AGENT);

        let (order_id, base_filled, is_placed, quote_filled) = deepbook::place_limit_order(
            pool,
            client_order_id,
            price,
            quantity,
            self_matching_prevention,
            is_bid,
            expire_timestamp,
            restriction,
            clock,
            &treasury.account_cap,
            ctx,
        );

        event::emit(OrderPlaced { client_order_id, price, quantity, is_bid });

        (order_id, base_filled, is_placed, quote_filled)
    }

    /// Agent places a POST_ONLY limit order (maker only, earns rebates).
    /// Convenience wrapper for yield-seeking strategies.
    public fun place_maker_order<BaseAsset, QuoteAsset>(
        treasury: &mut Treasury<QuoteAsset>,
        pool: &mut Pool<BaseAsset, QuoteAsset>,
        client_order_id: u64,
        price: u64,
        quantity: u64,
        is_bid: bool,
        expire_timestamp: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ): (u64, u64, bool, u64) {
        place_limit_order(
            treasury,
            pool,
            client_order_id,
            price,
            quantity,
            0, // no self-matching prevention needed
            is_bid,
            expire_timestamp,
            POST_ONLY,
            clock,
            ctx,
        )
    }

    /// Agent cancels an existing order on DeepBook.
    public entry fun cancel_order<BaseAsset, QuoteAsset>(
        treasury: &mut Treasury<QuoteAsset>,
        pool: &mut Pool<BaseAsset, QuoteAsset>,
        order_id: u64,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == treasury.agent, E_NOT_AGENT);
        deepbook::cancel_order(pool, order_id, &treasury.account_cap);
        event::emit(OrderCancelled { order_id });
    }

    // ========================================================================
    // Cross-Pool Rebalancing (PTB-Composable)
    // ========================================================================

    /// Atomic rebalance: move quote asset from one DeepBook pool to another.
    /// Designed for single-PTB execution (withdraw + deposit in one tx).
    public fun rebalance_quote<BaseA, QuoteAsset, BaseB>(
        treasury: &mut Treasury<QuoteAsset>,
        from_pool: &mut Pool<BaseA, QuoteAsset>,
        to_pool: &mut Pool<BaseB, QuoteAsset>,
        amount: u64,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == treasury.agent, E_NOT_AGENT);

        // Withdraw from source pool
        let coin = deepbook::withdraw_quote(from_pool, amount, &treasury.account_cap, ctx);
        let actual = coin::value(&coin);

        // Deposit to destination pool
        deepbook::deposit_quote(to_pool, coin, &treasury.account_cap);

        event::emit(PoolAction { action: b"rebalance", amount: actual });
    }

    // ========================================================================
    // Admin Functions
    // ========================================================================

    /// Update the agent address (admin only via AdminCap).
    public entry fun set_agent<T>(
        treasury: &mut Treasury<T>,
        _cap: &AdminCap,
        new_agent: address,
    ) {
        treasury.agent = new_agent;
        event::emit(AgentUpdated { new_agent });
    }

    // ========================================================================
    // View Functions
    // ========================================================================

    /// Current balance held directly in the treasury (not in pools).
    public fun get_balance<T>(treasury: &Treasury<T>): u64 {
        balance::value(&treasury.balance)
    }

    /// Total ever deposited into the treasury.
    public fun get_total_deposited<T>(treasury: &Treasury<T>): u64 {
        treasury.total_deposited
    }

    /// Total currently deployed in DeepBook pools.
    public fun get_total_in_pools<T>(treasury: &Treasury<T>): u64 {
        treasury.total_in_pools
    }

    /// Current agent address.
    public fun get_agent<T>(treasury: &Treasury<T>): address {
        treasury.agent
    }

    /// Current admin address.
    public fun get_admin<T>(treasury: &Treasury<T>): address {
        treasury.admin
    }

    // ========================================================================
    // Test-Only Helpers
    // ========================================================================

    #[test_only]
    public fun get_account_cap<T>(treasury: &Treasury<T>): &AccountCap {
        &treasury.account_cap
    }
}
